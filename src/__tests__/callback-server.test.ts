import { afterEach, describe, expect, it, vi } from 'vitest';
import * as crypto from 'node:crypto';
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
    expect((await post('not json')).status).toBe(400);
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
