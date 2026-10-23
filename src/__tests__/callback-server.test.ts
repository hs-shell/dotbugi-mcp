import { afterEach, describe, expect, it, vi } from 'vitest';
import * as crypto from 'node:crypto';
import { request } from 'node:http';
import { CALLBACK_MAX_BODY_BYTES } from '../constants.js';
import { startCallbackServer, type CallbackServer } from '../login/callback-server.js';

vi.mock('node:crypto', async (orig) => {
  const mod = await orig<typeof import('node:crypto')>();
  return { ...mod, timingSafeEqual: vi.fn(mod.timingSafeEqual) };
});

const ORIGIN = 'chrome-extension://fbhdnbombekihdhjcfiimiibfmikghch';
const SESSION = 'abcdefghij0123456789xyz';
let server: CallbackServer;

afterEach(() => server?.close());

async function start(timeoutMs = 10_000) {
  server = await startCallbackServer([ORIGIN], timeoutMs);
  // 거부 시 session 이 reject 되므로 처리되지 않은 rejection 으로 남지 않게 한다
  server.session.catch(() => undefined);
  return server;
}

function post(body: unknown, init: { origin?: string; path?: string; method?: string } = {}) {
  return fetch(`http://127.0.0.1:${server.port}${init.path ?? '/cb'}`, {
    method: init.method ?? 'POST',
    headers: { origin: init.origin ?? ORIGIN, 'content-type': 'application/json' },
    body: init.method === 'GET' ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  });
}

describe('startCallbackServer', () => {
  it('다른 출처는 403', async () => {
    await start();
    const res = await post({ code: server.code, session: SESSION }, { origin: 'chrome-extension://evil' });
    expect(res.status).toBe(403);
  });

  it('코드가 틀리면 403', async () => {
    await start();
    expect((await post({ code: 'wrong', session: SESSION })).status).toBe(403);
  });

  it('세션 형식이 이상하면 400', async () => {
    await start();
    expect((await post({ code: server.code, session: 'bad;session' })).status).toBe(400);
    await start();
    expect((await post('not json')).status).toBe(400);
  });

  it('잘못된 요청 한 번이면 중단한다 (재시도·추측 불가)', async () => {
    await start();
    expect((await post({ code: 'wrong', session: SESSION })).status).toBe(403);
    await expect(server.session).rejects.toThrow('잘못된 연결 요청');
    await expect(post({ code: server.code, session: SESSION })).rejects.toThrow();
  });

  it('Host 헤더가 127.0.0.1:<port> 가 아니면 421', async () => {
    await start();
    const status = await new Promise<number | undefined>((resolve, reject) => {
      const req = request(
        {
          host: '127.0.0.1',
          port: server.port,
          path: '/cb',
          method: 'POST',
          headers: { host: `localhost:${server.port}`, origin: ORIGIN },
        },
        (res) => resolve(res.statusCode)
      );
      req.once('error', reject);
      req.end(JSON.stringify({ code: server.code, session: SESSION }));
    });
    expect(status).toBe(421);
  });

  it('동시에 온 두 번째 유효 요청은 받지 않는다', async () => {
    await start();
    const results = await Promise.allSettled([
      post({ code: server.code, session: SESSION }),
      post({ code: server.code, session: SESSION }),
    ]);
    const statuses = results.map((r) => (r.status === 'fulfilled' ? r.value.status : 'error'));
    expect(statuses.filter((s) => s === 200)).toHaveLength(1);
    await expect(server.session).resolves.toBe(SESSION);
  });

  it('본문이 크기 제한을 넘으면 413', async () => {
    await start();
    expect((await post('x'.repeat(CALLBACK_MAX_BODY_BYTES + 1))).status).toBe(413);
  });

  it('POST /cb 외에는 404', async () => {
    await start();
    expect((await post({}, { path: '/other' })).status).toBe(404);
    expect((await post(undefined, { method: 'GET' })).status).toBe(404);
  });

  it('코드는 timingSafeEqual 로 비교한다', async () => {
    await start();
    vi.mocked(crypto.timingSafeEqual).mockClear();
    await post({ code: 'wrong', session: SESSION });
    expect(crypto.timingSafeEqual).toHaveBeenCalled();
  });

  it('유효한 요청을 한 번 받고 닫힌다', async () => {
    await start();
    const res = await post({ code: server.code, session: SESSION });
    expect(res.status).toBe(200);
    expect(res.headers.get('access-control-allow-origin')).toBe(ORIGIN);
    await expect(server.session).resolves.toBe(SESSION);
    await expect(post({ code: server.code, session: SESSION })).rejects.toThrow();
  });

  it('시간 초과 시 reject 하고 닫힌다', async () => {
    await start(50);
    await expect(server.session).rejects.toThrow('시간이 초과');
    await expect(post({ code: server.code, session: SESSION })).rejects.toThrow();
  });
});
