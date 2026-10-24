import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFrameDecoder, encodeFrame } from '../login/cdp-frame.js';

// 실제 브라우저 대신 CDP 파이프(fd 3·4)에 답하는 가짜 자식 프로세스
interface FakeBrowser extends EventEmitter {
  stdio: [null, null, null, PassThrough, PassThrough];
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
  kill: () => boolean;
  args: string[];
  methods: string[];
}
const fake = vi.hoisted(() => ({
  browser: undefined as unknown as FakeBrowser,
  // CDP 메서드별 응답. undefined 를 돌려주면 답하지 않는다
  respond: (() => undefined) as (method: string) => unknown,
  answerClose: true,
}));

function exit(b: FakeBrowser, code: number | null, signal: NodeJS.Signals | null) {
  b.exitCode = code;
  b.signalCode = signal;
  b.stdio[4].end();
  b.emit('exit', code, signal);
}

function makeBrowser(args: string[]): FakeBrowser {
  const b = Object.assign(new EventEmitter(), {
    stdio: [null, null, null, new PassThrough(), new PassThrough()],
    exitCode: null,
    signalCode: null,
    args,
    methods: [] as string[],
  }) as unknown as FakeBrowser;
  b.kill = vi.fn(() => {
    setImmediate(() => exit(b, null, 'SIGTERM'));
    return true;
  });
  b.stdio[3].on(
    'data',
    createFrameDecoder((raw) => {
      const { id, method } = JSON.parse(raw) as { id: number; method: string };
      b.methods.push(method);
      if (method === 'Browser.close') {
        if (!fake.answerClose) return;
        b.stdio[4].write(encodeFrame({ id, result: {} }));
        setImmediate(() => exit(b, 0, null));
        return;
      }
      const result = fake.respond(method);
      if (result !== undefined) b.stdio[4].write(encodeFrame({ id, result }));
    })
  );
  return b;
}

vi.mock('node:child_process', async (orig) => ({
  ...(await orig<typeof import('node:child_process')>()),
  spawn: vi.fn((_cmd: string, args: string[]) => (fake.browser = makeBrowser(args))),
}));
// 5분 대기·15초 CDP 제한을 테스트용으로 줄인다
vi.mock('../constants.js', async (orig) => ({
  ...(await orig<typeof import('../constants.js')>()),
  LOGIN_TIMEOUT_MS: 150,
  POLL_INTERVAL_MS: 5,
  CDP_CALL_TIMEOUT_MS: 50,
  BROWSER_EXIT_WAIT_MS: 30,
}));
const isWsl = vi.fn(() => false);
vi.mock('../platform.js', () => ({ isWsl: () => isWsl() }));
const findBrowser = vi.fn<() => string | null>(() => '/fake/chrome');
vi.mock('../login/find-browser.js', () => ({ findBrowser: () => findBrowser() }));
const verifySession = vi.fn<(s: string) => Promise<boolean>>();
vi.mock('../lms.js', () => ({ verifySession: (s: string) => verifySession(s) }));
const logs: string[] = [];
vi.mock('../log.js', () => ({ log: (m: string) => logs.push(m) }));

const { spawn } = await import('node:child_process');
const { loginWithBrowser, findLoginBrowser, WSL_UNSUPPORTED } = await import('../login/browser.js');

const L = 'https://learn.hansung.ac.kr';
const SESSION = 'abcdefghij0123456789';
const OTHER = 'zyxwvutsrq9876543210';
const page = (url: string) => ({ type: 'page', url });
const cookie = (domain: string, value: string, name = 'MoodleSession') => ({ name, value, domain });

const profileDir = () => fake.browser.args.find((a) => a.startsWith('--user-data-dir='))!.split('=')[1];
let signalListeners: number;

beforeEach(() => {
  fake.answerClose = true;
  logs.length = 0;
  isWsl.mockReturnValue(false);
  findBrowser.mockReturnValue('/fake/chrome');
  verifySession.mockReset().mockResolvedValue(true);
  signalListeners =
    process.listenerCount('SIGINT') + process.listenerCount('SIGTERM') + process.listenerCount('SIGHUP');
});
afterEach(() => {
  // 어느 경로로 끝나도 신호 처리기를 남기지 않는다
  expect(process.listenerCount('SIGINT') + process.listenerCount('SIGTERM') + process.listenerCount('SIGHUP')).toBe(
    signalListeners
  );
  vi.mocked(spawn).mockClear();
});

describe('findLoginBrowser', () => {
  it('WSL 이면 창을 띄우지 않고 거절', async () => {
    isWsl.mockReturnValue(true);
    expect(() => findLoginBrowser()).toThrow(WSL_UNSUPPORTED);
    await expect(loginWithBrowser()).rejects.toThrow(WSL_UNSUPPORTED);
    expect(spawn).not.toHaveBeenCalled();
  });

  it('브라우저가 없으면 오류', () => {
    findBrowser.mockReturnValue(null);
    expect(() => findLoginBrowser()).toThrow('설치된 브라우저를 찾지 못했습니다');
  });
});

describe('loginWithBrowser', () => {
  it('로그인 화면을 벗어난 LMS 페이지가 보이면 정확한 호스트의 MoodleSession 만 꺼내 확인 후 돌려주고 정리한다', async () => {
    let polls = 0;
    fake.respond = (m) => {
      if (m === 'Target.getTargets')
        return { targetInfos: ++polls < 3 ? [page(`${L}/login/index.php`)] : [page(`${L}/my/`)] };
      if (m === 'Storage.getCookies')
        return {
          cookies: [
            cookie(`sub.learn.hansung.ac.kr`, OTHER),
            cookie(`learn.hansung.ac.kr.evil.example`, OTHER),
            cookie('learn.hansung.ac.kr', OTHER, 'OtherCookie'),
            cookie('learn.hansung.ac.kr', SESSION),
          ],
        };
    };
    await expect(loginWithBrowser()).resolves.toBe(SESSION);
    expect(verifySession.mock.calls).toEqual([[SESSION]]);
    // 디버깅은 TCP 포트가 아닌 파이프, 프로필은 새 임시 폴더
    const args = fake.browser.args;
    expect(args).toContain('--remote-debugging-pipe');
    expect(args.some((a) => a.startsWith('--remote-debugging-port'))).toBe(false);
    expect(profileDir().startsWith(join(tmpdir(), 'dotbugi-login-'))).toBe(true);
    expect(args.at(-1)).toBe(`${L}/login/index.php`);
    expect(fake.browser.methods).toContain('Browser.close');
    expect(existsSync(profileDir())).toBe(false);
    expect(logs.join('\n')).not.toContain(SESSION);
  });

  it('게스트 페이지의 쿠키처럼 서버가 거절한 세션은 다시 묻지 않고, 새로 발급된 값을 받는다', async () => {
    let value = OTHER;
    fake.respond = (m) => {
      if (m === 'Target.getTargets') return { targetInfos: [page(`${L}/`)] };
      if (m === 'Storage.getCookies') return { cookies: [cookie('.learn.hansung.ac.kr', value)] };
    };
    verifySession.mockImplementation(async (s) => {
      // 거절 후 사용자가 로그인해 세션 ID 가 바뀐 상황
      if (s === OTHER) setTimeout(() => (value = SESSION), 20);
      return s === SESSION;
    });
    await expect(loginWithBrowser()).resolves.toBe(SESSION);
    expect(verifySession.mock.calls).toEqual([[OTHER], [SESSION]]);
    expect(existsSync(profileDir())).toBe(false);
  });

  it('로그인 전에 창을 닫으면 실패하고 프로필을 지운다', async () => {
    fake.respond = (m) => {
      if (m === 'Target.getTargets') {
        setImmediate(() => exit(fake.browser, 0, null));
        return { targetInfos: [page(`${L}/login/index.php`)] };
      }
    };
    await expect(loginWithBrowser()).rejects.toThrow('브라우저 창이 닫혔습니다');
    expect(existsSync(profileDir())).toBe(false);
  });

  it('시간이 지나면 실패하고, Browser.close 에 답이 없으면 프로세스를 죽인 뒤 프로필을 지운다. 오류에 쿠키 값이 없다', async () => {
    fake.answerClose = false;
    fake.respond = (m) => {
      if (m === 'Target.getTargets') return { targetInfos: [page(`${L}/my/`)] };
      if (m === 'Storage.getCookies') return { cookies: [cookie('learn.hansung.ac.kr', SESSION)] };
    };
    // 확인 요청이 네트워크 오류로 실패하면 거절로 치지 않고 계속 기다린다
    verifySession.mockRejectedValue(new Error(`network ${SESSION}`));
    const err = (await loginWithBrowser().catch((e: unknown) => e)) as Error;
    expect(err.message).toContain('시간이 초과');
    expect(err.message).not.toContain(SESSION);
    expect(verifySession.mock.calls.length).toBeGreaterThan(1);
    expect(fake.browser.kill).toHaveBeenCalled();
    expect(existsSync(profileDir())).toBe(false);
  });

  it('CDP 오류로 실패해도 프로필을 지운다', async () => {
    fake.respond = () => undefined; // Target.getTargets 에 답하지 않아 CDP 시간 제한
    await expect(loginWithBrowser()).rejects.toThrow('Target.getTargets 응답이 없습니다');
    expect(existsSync(profileDir())).toBe(false);
  });
});
