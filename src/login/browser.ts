import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import {
  BROWSER_EXIT_WAIT_MS,
  CDP_PORT_FILE,
  CDP_PORT_WAIT_MS,
  LMS_HOST,
  LMS_LOGIN_PAGE_PATH,
  LMS_ORIGIN,
  LOGIN_TIMEOUT_MS,
  LOGIN_URL_MARKER,
  POLL_INTERVAL_MS,
  SESSION_COOKIE,
  SESSION_PATTERN,
} from '../constants.js';
import { log } from '../log.js';
import { isWsl } from '../platform.js';
import { findBrowser } from './find-browser.js';

const NOTICE = `임시 Chrome 창을 엽니다.
  - 창의 주소가 ${LMS_ORIGIN} 인지 확인한 뒤 로그인하세요.
  - 이 창은 새 임시 프로필이라 평소 브라우저의 정보(쿠키·비밀번호·기록)에 접근하지 않습니다.
  - 로그인이 끝나면 창은 자동으로 닫히고 임시 프로필은 삭제됩니다. (5분 제한)`;

interface CdpTarget {
  type: string;
  url: string;
}
interface CdpCookie {
  name: string;
  value: string;
  domain: string;
}

// 대체 방식: 임시 프로필 브라우저 창에서 사용자가 직접 로그인 → CDP 로 LMS 세션 쿠키만 꺼낸다
export async function loginWithBrowser(): Promise<string> {
  // WSL 에서는 Windows 브라우저의 디버깅 포트(127.0.0.1)에 NAT 때문에 닿지 않는다.
  // PowerShell 로 CDP 를 한 벌 더 구현하는 대신 지원하지 않는다 (WSL 은 확장 방식 사용)
  if (isWsl()) {
    throw new Error(
      'WSL 에서는 --browser 를 지원하지 않습니다. dotbugi 확장 방식(dotbugi-mcp login)을 쓰거나 Windows 터미널에서 실행하세요.'
    );
  }
  const browserPath = findBrowser();
  if (!browserPath) throw new Error('Chrome·Edge·Brave·Whale 중 설치된 브라우저를 찾지 못했습니다.');

  log(NOTICE);
  const profileDir = await mkdtemp(join(tmpdir(), 'dotbugi-login-'));
  // 주소창이 보이는 일반 창으로 띄운다 (--app·시크릿 모드 아님 — 사용자가 주소를 확인할 수 있어야 한다)
  const browser = spawn(
    browserPath,
    [
      '--remote-debugging-port=0',
      `--user-data-dir=${profileDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      `${LMS_ORIGIN}${LMS_LOGIN_PAGE_PATH}`,
    ],
    { stdio: 'ignore' }
  );
  const exited = new Promise<void>((resolve) => browser.once('exit', () => resolve()));
  const isClosed = () => browser.exitCode !== null || browser.signalCode !== null;
  let browserWs: string | undefined;
  try {
    const port = await readDevToolsPort(profileDir, isClosed);
    browserWs = (
      (await (await fetch(`http://127.0.0.1:${port}/json/version`)).json()) as { webSocketDebuggerUrl: string }
    ).webSocketDebuggerUrl;
    await waitForLogin(port, isClosed);
    // 임시 프로필엔 이번 로그인만 있으므로 브라우저 전체 쿠키 중 LMS 세션 쿠키만 고르면 된다
    const { cookies } = (await cdp(browserWs, 'Storage.getCookies')) as { cookies: CdpCookie[] };
    const session = cookies.find(
      (c) => c.name === SESSION_COOKIE && (c.domain === LMS_HOST || c.domain === `.${LMS_HOST}`)
    )?.value;
    if (!session || !SESSION_PATTERN.test(session)) throw new Error('LMS 세션 쿠키를 찾지 못했습니다.');
    return session;
  } finally {
    await closeBrowser(browser, exited, browserWs);
    await rm(profileDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
}

async function readDevToolsPort(profileDir: string, isClosed: () => boolean): Promise<number> {
  const deadline = Date.now() + CDP_PORT_WAIT_MS;
  while (!isClosed() && Date.now() < deadline) {
    const port = Number((await readFile(join(profileDir, CDP_PORT_FILE), 'utf8').catch(() => '')).split('\n')[0]);
    if (port > 0) return port;
    await sleep(POLL_INTERVAL_MS / 4);
  }
  throw new Error('브라우저 디버깅 포트를 확인하지 못했습니다.');
}

// LMS 페이지가 로그인 관련 URL 을 벗어나면 로그인 완료로 본다
async function waitForLogin(port: number, isClosed: () => boolean): Promise<void> {
  const deadline = Date.now() + LOGIN_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (isClosed()) throw new Error('로그인 전에 브라우저 창이 닫혔습니다.');
    const targets = (await fetch(`http://127.0.0.1:${port}/json/list`)
      .then((r) => r.json())
      .catch(() => [])) as CdpTarget[];
    if (
      targets.some((t) => t.type === 'page' && t.url.startsWith(`${LMS_ORIGIN}/`) && !t.url.includes(LOGIN_URL_MARKER))
    )
      return;
    await sleep(POLL_INTERVAL_MS);
  }
  throw new Error('시간이 초과되었습니다. dotbugi-mcp login --browser 를 다시 실행하세요.');
}

async function closeBrowser(browser: ChildProcess, exited: Promise<void>, browserWs?: string): Promise<void> {
  if (browser.exitCode !== null || browser.signalCode !== null) return;
  if (browserWs) await cdp(browserWs, 'Browser.close').catch(() => undefined);
  const timedOut = await Promise.race([exited.then(() => false), sleep(BROWSER_EXIT_WAIT_MS).then(() => true)]);
  if (timedOut) {
    browser.kill();
    await exited;
  }
}

// CDP 명령 하나를 보내고 응답을 받는다 (Node 내장 WebSocket)
function cdp(wsUrl: string, method: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    ws.onopen = () => ws.send(JSON.stringify({ id: 1, method }));
    ws.onerror = () => reject(new Error(`CDP ${method} 실패`));
    ws.onmessage = (ev) => {
      const msg = JSON.parse(String(ev.data)) as { id?: number; result?: unknown; error?: unknown };
      if (msg.id !== 1) return;
      ws.close();
      if (msg.error) reject(new Error(`CDP ${method} 실패`));
      else resolve(msg.result);
    };
  });
}
