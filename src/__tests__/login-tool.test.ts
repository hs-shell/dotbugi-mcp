import { InMemoryTransport, LATEST_PROTOCOL_VERSION, type JSONRPCMessage } from '@modelcontextprotocol/server';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createServer } from '../server.js';

const SESSION = 'abcdefghij0123456789xyz';
const ORIGIN = 'chrome-extension://fbhdnbombekihdhjcfiimiibfmikghch';

// 시간 초과 정리를 빨리 보려고 제한을 줄인다
vi.mock('../constants.js', async (orig) => ({ ...(await orig<object>()), LOGIN_TIMEOUT_MS: 500 }));
const opened: string[] = [];
vi.mock('../platform.js', async (orig) => ({
  ...(await orig<object>()),
  openUrl: vi.fn(async (url: string) => void opened.push(url)),
}));
const keychain = vi.hoisted(() => ({ value: null as string | null }));
vi.mock('../keychain/index.js', () => ({
  getKeychain: () => ({
    get: async () => keychain.value,
    set: async (v: string) => void (keychain.value = v),
    delete: async () => true,
  }),
}));
const verifySession = vi.fn<(s: string) => Promise<boolean>>(async () => true);
vi.mock('../lms.js', async (orig) => ({ ...(await orig<object>()), verifySession: (s: string) => verifySession(s) }));

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

const login = async () =>
  ((await send('tools/call', { name: 'login', arguments: {} })).content as { text: string }[])[0].text;
// 브라우저로 연 URL 해시의 포트·일회용 코드
const connect = (url: string) => {
  const [port, code] = new URL(url).hash.split('=')[1].split('.');
  return { port, code };
};
const post = (port: string, body: unknown) =>
  fetch(`http://127.0.0.1:${port}/cb`, { method: 'POST', headers: { origin: ORIGIN }, body: JSON.stringify(body) });

afterEach(() => {
  opened.length = 0;
  keychain.value = null;
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
    await login();
    expect(opened).toHaveLength(2);
    stderr.mockRestore();
  });
});
