import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Readable, Writable } from 'node:stream';
import { setTimeout as sleep } from 'node:timers/promises';
import {
  BROWSER_EXIT_WAIT_MS,
  CDP_CALL_TIMEOUT_MS,
  LMS_LOGIN_PAGE_PATH,
  LMS_ORIGIN,
  LOGIN_TIMEOUT_MS,
  LOGIN_URL_MARKER,
  POLL_INTERVAL_MS,
  SIGNAL_EXIT_CODES,
} from '../constants.js';
import { verifySession } from '../lms.js';
import { log } from '../log.js';
import { isWsl } from '../platform.js';
import { createCdpClient, type CdpClient } from './cdp-pipe.js';
import { findBrowser } from './find-browser.js';
import { pickSessionCookie, type CdpCookie } from './session-cookie.js';

const NOTICE = `임시 Chrome 창을 엽니다.
  - 창의 주소가 ${LMS_ORIGIN} 인지 확인한 뒤 로그인하세요.
  - 이 창은 새 임시 프로필이라 평소 브라우저의 정보(쿠키·비밀번호·기록)에 접근하지 않습니다.
  - 로그인이 끝나면 창은 자동으로 닫히고 임시 프로필은 삭제됩니다. (5분 제한)`;

interface CdpTarget {
  type: string;
  url: string;
}

// 임시 프로필 로그인을 쓸 수 있는지 먼저 확인한다 (login 도구는 창을 띄우기 전에 바로 거절하려고 따로 부른다)
export function findLoginBrowser(): string {
  // CDP 파이프(fd 3·4)는 WSL interop 을 넘어 Windows 프로세스로 전달되지 않는다 (stdin/stdout/stderr 만 중계).
  // PowerShell 로 CDP 를 한 벌 더 구현하는 대신 지원하지 않는다 (WSL 은 확장 방식 사용)
  if (isWsl()) {
    throw new Error(
      'WSL 에서는 --browser 를 지원하지 않습니다. dotbugi 확장 방식(dotbugi-mcp login)을 쓰거나 Windows 터미널에서 실행하세요.'
    );
  }
  const browserPath = findBrowser();
  if (!browserPath) throw new Error('Chrome·Edge·Brave·Whale 중 설치된 브라우저를 찾지 못했습니다.');
  return browserPath;
}

// 대체 방식: 임시 프로필 브라우저 창에서 사용자가 직접 로그인 → CDP 로 LMS 세션 쿠키만 꺼낸다
export async function loginWithBrowser(): Promise<string> {
  const browserPath = findLoginBrowser();
  log(NOTICE);
  const profileDir = await mkdtemp(join(tmpdir(), 'dotbugi-login-'));
  // 디버깅은 TCP 포트 대신 파이프로 연다 — 로그인 대기 중 같은 기기의 다른 사용자·프로세스가 붙을 수 없다.
  // 주소창이 보이는 일반 창으로 띄운다 (--app·시크릿 모드 아님 — 사용자가 주소를 확인할 수 있어야 한다)
  const browser = spawn(
    browserPath,
    [
      '--remote-debugging-pipe',
      `--user-data-dir=${profileDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      `${LMS_ORIGIN}${LMS_LOGIN_PAGE_PATH}`,
    ],
    { stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'] }
  );
  const exited = new Promise<void>((resolve) => browser.once('exit', () => resolve()).once('error', () => resolve()));
  const cdp = createCdpClient(browser.stdio[3] as Writable, browser.stdio[4] as Readable, CDP_CALL_TIMEOUT_MS);

  // 정상 종료·오류·Ctrl+C 어느 경로든 한 번만 정리한다 (프로필의 쿠키 DB 에 살아 있는 세션이 남기 때문)
  let cleaning: Promise<void> | undefined;
  const cleanup = () => (cleaning ??= closeBrowser(browser, exited, cdp).then(() => removeProfile(profileDir)));
  const onSignal = (signal: keyof typeof SIGNAL_EXIT_CODES) =>
    void cleanup().finally(() => process.exit(SIGNAL_EXIT_CODES[signal]));
  process.once('SIGINT', onSignal).once('SIGTERM', onSignal);
  try {
    return await waitForSession(cdp, () => isClosed(browser));
  } finally {
    process.off('SIGINT', onSignal).off('SIGTERM', onSignal);
    await cleanup();
  }
}

// 로그인 관련 URL 을 벗어난 LMS 페이지가 보이면 세션 쿠키를 서버에 확인한다.
// 비로그인(게스트)도 MoodleSession 을 받으므로 URL 만으로는 완료로 보지 않는다
async function waitForSession(cdp: CdpClient, closed: () => boolean): Promise<string> {
  const deadline = Date.now() + LOGIN_TIMEOUT_MS;
  let rejected: string | undefined;
  while (Date.now() < deadline) {
    if (closed()) throw new Error('로그인 전에 브라우저 창이 닫혔습니다.');
    const { targetInfos } = (await cdp.send('Target.getTargets')) as { targetInfos: CdpTarget[] };
    if (targetInfos.some(isLmsPageAfterLogin)) {
      const { cookies } = (await cdp.send('Storage.getCookies')) as { cookies: CdpCookie[] };
      const session = pickSessionCookie(cookies);
      // 확인에서 거절된 값은 다시 묻지 않는다 (로그인하면 Moodle 이 세션 ID 를 새로 발급한다)
      if (session && session !== rejected) {
        const ok = await verifySession(session).catch(() => undefined);
        if (ok) return session;
        if (ok === false) rejected = session;
      }
    }
    await sleep(POLL_INTERVAL_MS);
  }
  throw new Error('시간이 초과되었습니다. dotbugi-mcp login --browser 를 다시 실행하세요.');
}

function isLmsPageAfterLogin(t: CdpTarget): boolean {
  return t.type === 'page' && t.url.startsWith(`${LMS_ORIGIN}/`) && !t.url.includes(LOGIN_URL_MARKER);
}

function isClosed(browser: ChildProcess): boolean {
  return browser.exitCode !== null || browser.signalCode !== null;
}

async function closeBrowser(browser: ChildProcess, exited: Promise<void>, cdp: CdpClient): Promise<void> {
  if (isClosed(browser)) return;
  await cdp.send('Browser.close').catch(() => undefined);
  const timedOut = await Promise.race([exited.then(() => false), sleep(BROWSER_EXIT_WAIT_MS).then(() => true)]);
  if (timedOut) {
    browser.kill();
    await exited;
  }
}

// 삭제 실패가 로그인 결과를 덮어쓰지 않도록 경고만 남긴다 (경로는 비밀이 아님)
async function removeProfile(profileDir: string): Promise<void> {
  try {
    await rm(profileDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  } catch {
    log(`경고: 임시 프로필을 삭제하지 못했습니다. 직접 삭제하세요: ${profileDir}`);
  }
}
