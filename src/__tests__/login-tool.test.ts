import { InMemoryTransport, LATEST_PROTOCOL_VERSION, type JSONRPCMessage } from '@modelcontextprotocol/server';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { openUrl } from '../platform.js';
import { createServer } from '../server.js';
import { cancelPendingLogin } from '../tools/login.js';

const SESSION = 'abcdefghij0123456789xyz';
const ORIGIN = 'chrome-extension://fbhdnbombekihdhjcfiimiibfmikghch';

// 시간 초과 정리를 빨리 보려고 제한을 줄인다
vi.mock('../constants.js', async (orig) => ({ ...(await orig<object>()), LOGIN_TIMEOUT_MS: 500 }));
const opened: string[] = [];
vi.mock('../platform.js', async (orig) => ({
  ...(await orig<object>()),
  openUrl: vi.fn(async (url: string) => void opened.push(url)),
  isWsl: () => wsl.value,
}));
const wsl = vi.hoisted(() => ({ value: false }));
// 임시 프로필 창(CDP)은 띄우지 않고, 사용자가 로그인을 끝내는 시점을 테스트가 정한다
vi.mock('../login/find-browser.js', () => ({ findBrowser: () => '/fake/chrome' }));
const loginWithBrowser = vi.fn<() => Promise<string>>();
vi.mock('../login/browser.js', async (orig) => ({
  ...(await orig<object>()),
  loginWithBrowser: () => loginWithBrowser(),
}));
const keychain = vi.hoisted(() => ({ value: null as string | null, broken: false }));
vi.mock('../keychain/index.js', () => ({
  getKeychain: () => ({
    get: async () => {
      if (keychain.broken) throw new Error('no secret service');
      return keychain.value;
    },
    set: async (v: string) => void (keychain.value = v),
    delete: async () => ((keychain.value = null), true),
  }),
}));
const verifySession = vi.fn<(s: string) => Promise<boolean>>(async () => true);
const lmsLogout = vi.fn<(s: string) => Promise<boolean>>(async () => true);
vi.mock('../lms.js', async (orig) => ({
  ...(await orig<object>()),
  verifySession: (s: string) => verifySession(s),
  lmsLogout: (s: string) => lmsLogout(s),
}));

let send: (method: string, params?: Record<string, unknown>) => Promise<Record<string, unknown>>;
beforeAll(async () => {
  const [client, server] = InMemoryTransport.createLinkedPair();
  const waiting = new Map<number, (result: Record<string, unknown>) => void>();
  client.onmessage = (msg: JSONRPCMessage) => {
    if ('id' in msg && 'result' in msg) waiting.get(msg.id as number)?.(msg.result as Record<string, unknown>);
  };
  await createServer().connect(server);
  let id = 0;
  send = (method, params) =>
    new Promise((resolve) => {
      waiting.set(++id, resolve);
      void client.send({ jsonrpc: '2.0', id, method, params });
    });
  await send('initialize', {
    protocolVersion: LATEST_PROTOCOL_VERSION,
    capabilities: {},
    clientInfo: { name: 'test', version: '0' },
  });
  await client.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
});

const call = async (name: string, args: Record<string, unknown> = {}) => {
  const result = await send('tools/call', { name, arguments: args });
  return { text: (result.content as { text: string }[])[0].text, isError: result.isError === true };
};
const login = async (args?: Record<string, unknown>) => (await call('login', args)).text;
// 브라우저로 연 URL 해시의 포트·일회용 코드
const connect = (url: string) => {
  const [port, code] = new URL(url).hash.split('=')[1].split('.');
  return { port, code };
};
const post = (port: string, body: unknown) =>
  fetch(`http://127.0.0.1:${port}/cb`, { method: 'POST', headers: { origin: ORIGIN }, body: JSON.stringify(body) });

afterEach(() => {
  // 끝나지 않은 로그인이 다음 테스트(특히 logout 문구)에 섞이지 않게
  cancelPendingLogin();
  opened.length = 0;
  keychain.value = null;
  keychain.broken = false;
  wsl.value = false;
  verifySession.mockResolvedValue(true);
  loginWithBrowser.mockReset();
});

describe('login 도구', () => {
  it('유효한 세션이 있으면 브라우저를 열지 않는다', async () => {
    keychain.value = JSON.stringify({ session: SESSION, savedAt: '', method: 'extension' });
    expect(await login()).toContain('이미 로그인');
    expect(opened).toEqual([]);
  });

  it('확인 코드를 바로 돌려주고, 진행 중 재호출은 같은 연결을 쓰며, 승인되면 저장한다 (비밀값 비노출)', async () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const first = await login();
    const fingerprint = /[A-Z0-9_-]{3}-[A-Z0-9_-]{3}/i.exec(first)?.[0];
    expect(first).toContain('로그인을 시작했습니다');
    const second = await login();
    expect(second).toContain('진행 중');
    expect(second).toContain(fingerprint);
    expect(opened).toHaveLength(1);

    const { port, code } = connect(opened[0]);
    expect((await post(port, { code, session: SESSION })).status).toBe(200);
    await vi.waitFor(() => expect(keychain.value).toContain(SESSION));
    await vi.waitFor(() => expect(stderr).toHaveBeenCalledWith(expect.stringContaining('로그인 완료')));

    const logs = stderr.mock.calls.map((c) => String(c[0])).join('');
    for (const out of [first, second, logs]) {
      expect(out).not.toContain(code);
      expect(out).not.toContain(SESSION);
    }
    stderr.mockRestore();
  });

  it('시간이 지나면 콜백 서버를 닫고, 다음 호출은 새 연결을 연다', async () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    verifySession.mockResolvedValue(false);
    await login();
    const { port } = connect(opened[0]);
    await vi.waitFor(() => expect(stderr).toHaveBeenCalledWith(expect.stringContaining('시간이 초과')), {
      timeout: 2000,
    });
    await expect(post(port, {})).rejects.toThrow();
    // 직전 실패 이유는 다음 응답에 한 번만 보여 준다
    expect(await login()).toContain('직전 로그인 실패');
    expect(opened).toHaveLength(2);
    // 다음 테스트가 진행 중 연결에 묶이지 않게 두 번째 연결도 끝날 때까지 기다린다
    await vi.waitFor(
      () => expect(stderr.mock.calls.filter((c) => String(c[0]).includes('시간이 초과'))).toHaveLength(2),
      { timeout: 2000 }
    );
    stderr.mockRestore();
  });
});

describe('login 도구 실패', () => {
  it('OS 키체인을 쓸 수 없으면 브라우저를 열지 않고 거부한다', async () => {
    keychain.broken = true;
    const result = await call('login');
    expect(result.isError).toBe(true);
    expect(result.text).toContain('OS 키체인을 사용할 수 없어 로그인하지 않습니다');
    expect(opened).toEqual([]);
  });

  it('기본 브라우저를 열지 못하면 콜백 서버를 닫고 오류, 다음 호출은 새로 시작한다', async () => {
    vi.mocked(openUrl).mockImplementationOnce(async (url: string) => {
      opened.push(url);
      throw new Error('기본 브라우저를 열지 못했습니다.');
    });
    const result = await call('login');
    expect(result).toEqual({ text: '기본 브라우저를 열지 못했습니다.', isError: true });
    const { port } = connect(opened[0]);
    await expect(post(port, {})).rejects.toThrow();
    // 진행 중으로 남지 않는다 — 다음 호출이 새 연결을 연다 (시간 제한으로 끝날 때까지 기다려 다음 테스트와 섞이지 않게)
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      expect(await login()).toContain('로그인을 시작했습니다');
      expect(opened).toHaveLength(2);
      await vi.waitFor(() => expect(stderr).toHaveBeenCalledWith(expect.stringContaining('시간이 초과')), {
        timeout: 2000,
      });
    } finally {
      stderr.mockRestore();
    }
  });
});

describe('login 도구 method=browser', () => {
  it('바로 안내를 돌려주고, 진행 중 재호출은 창을 다시 띄우지 않으며, 로그인되면 browser 방식으로 저장한다 (비밀값 비노출)', async () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    let finish!: (s: string) => void;
    loginWithBrowser.mockReturnValue(new Promise((resolve) => (finish = resolve)));
    const first = await login({ method: 'browser' });
    expect(first).toContain('로그인을 시작했습니다');
    expect(first).toContain('자동으로 닫히고');
    expect(await login({ method: 'browser' })).toContain('진행 중');
    // 진행 중에는 다른 방식으로 불러도 새로 시작하지 않는다
    expect(await login()).toContain('진행 중');
    expect(loginWithBrowser).toHaveBeenCalledTimes(1);
    expect(opened).toEqual([]);

    finish(SESSION);
    await vi.waitFor(() => expect(keychain.value).toContain('"method":"browser"'));
    const logs = stderr.mock.calls.map((c) => String(c[0])).join('');
    expect(`${first}${logs}`).not.toContain(SESSION);
    expect(await login()).toContain('이미 로그인');
    stderr.mockRestore();
  });

  it('백그라운드 실패는 서버를 죽이지 않고 다음 호출에 한 번 알린다', async () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    loginWithBrowser.mockRejectedValueOnce(new Error('로그인 전에 브라우저 창이 닫혔습니다.'));
    await login({ method: 'browser' });
    await vi.waitFor(() => expect(stderr).toHaveBeenCalledWith(expect.stringContaining('창이 닫혔습니다')));
    let fail!: (err: Error) => void;
    loginWithBrowser.mockReturnValue(new Promise((_, reject) => (fail = reject)));
    const next = await login({ method: 'browser' });
    expect(next).toContain('직전 로그인 실패: 로그인 전에 브라우저 창이 닫혔습니다.');
    expect(next).toContain('로그인을 시작했습니다');
    fail(new Error('시간이 초과되었습니다.'));
    await vi.waitFor(() => expect(stderr).toHaveBeenCalledWith(expect.stringContaining('시간이 초과')));
    stderr.mockRestore();
  });

  it('WSL 에서는 창을 띄우지 않고 method=extension 을 안내한다', async () => {
    wsl.value = true;
    const result = await call('login', { method: 'browser' });
    expect(result.isError).toBe(true);
    expect(result.text).toContain('WSL 에서는 임시 브라우저 창 로그인을 지원하지 않습니다');
    expect(result.text).toContain('method=extension');
    expect(loginWithBrowser).not.toHaveBeenCalled();
    // 이미 로그인돼 있으면 WSL 이어도 거절하지 않는다
    keychain.value = JSON.stringify({ session: SESSION, savedAt: '', method: 'extension' });
    expect(await login({ method: 'browser' })).toContain('이미 로그인');
  });
});

describe('logout 도구', () => {
  it('browser 세션은 서버 로그아웃 후 키체인에서 지우고, 세션 값은 응답에 넣지 않는다', async () => {
    keychain.value = JSON.stringify({ session: SESSION, savedAt: '', method: 'browser' });
    const result = await call('logout');
    expect(result.isError).toBe(false);
    expect(lmsLogout).toHaveBeenCalledWith(SESSION);
    expect(result.text).toContain('LMS 서버 세션을 종료했습니다');
    expect(result.text).toContain('OS 키체인에서 세션을 삭제했습니다');
    expect(result.text).not.toContain(SESSION);
    expect(keychain.value).toBeNull();
    // 다시 불러도 오류 없이 없다고만 알린다
    expect((await call('logout')).text).toContain('저장된 세션이 없습니다');
  });

  it('확장 연결 세션은 서버 로그아웃 없이 지우고, 서버 로그아웃 실패도 지우기는 한다', async () => {
    lmsLogout.mockClear();
    keychain.value = JSON.stringify({ session: SESSION, savedAt: '', method: 'extension' });
    const ext = await call('logout');
    expect(ext.text).toContain('LMS 서버 로그아웃은 하지 않습니다');
    expect(lmsLogout).not.toHaveBeenCalled();
    expect(keychain.value).toBeNull();

    keychain.value = JSON.stringify({ session: SESSION, savedAt: '', method: 'browser' });
    lmsLogout.mockRejectedValueOnce(new Error(`network ${SESSION}`));
    const failed = await call('logout');
    expect(failed.text).toContain('이미 만료되었거나 종료하지 못했습니다');
    expect(failed.text).not.toContain(SESSION);
    expect(keychain.value).toBeNull();
  });

  it('형식이 깨진 세션은 서버 로그아웃 없이 지운다', async () => {
    lmsLogout.mockClear();
    keychain.value = '{not json';
    const result = await call('logout');
    expect(result).toEqual({ text: '형식이 올바르지 않은 세션을 OS 키체인에서 삭제했습니다.', isError: false });
    expect(lmsLogout).not.toHaveBeenCalled();
    expect(keychain.value).toBeNull();
  });

  it('키체인 오류는 도구 오류로 돌려준다', async () => {
    keychain.broken = true;
    const result = await call('logout');
    expect(result).toEqual({ text: 'no secret service', isError: true });
  });

  it('대기 중인 로그인을 취소해, 나중에 세션이 도착해도 저장하지 않는다', async () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    let finish!: (s: string) => void;
    loginWithBrowser.mockReturnValue(new Promise((resolve) => (finish = resolve)));
    await login({ method: 'browser' });
    expect((await call('logout')).text).toContain('진행 중이던 로그인을 취소했습니다');
    finish(SESSION);
    await vi.waitFor(() => expect(stderr).toHaveBeenCalledWith(expect.stringContaining('저장하지 않았습니다')));
    expect(keychain.value).toBeNull();
    // 취소 뒤에는 새 로그인을 시작할 수 있다
    loginWithBrowser.mockReturnValue(new Promise(() => {}));
    expect(await login({ method: 'browser' })).toContain('로그인을 시작했습니다');
    stderr.mockRestore();
  });
});
