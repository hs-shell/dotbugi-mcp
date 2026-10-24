import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionExpiredError } from '../lms.js';
import { clearSessionCache, deleteSession, getSession, readSession, saveSession } from '../session.js';

const get = vi.fn();
const set = vi.fn();
const del = vi.fn();
vi.mock('../keychain/index.js', () => ({ getKeychain: () => ({ get, set, delete: del }) }));

const SESSION = 'abcdefghij0123456789xyz';
beforeEach(() => {
  get.mockReset();
  clearSessionCache();
});

describe('readSession', () => {
  it('올바른 값은 그대로 돌려준다', async () => {
    const stored = { session: SESSION, savedAt: '2026-01-01T00:00:00.000Z', method: 'browser' };
    get.mockResolvedValue(JSON.stringify(stored));
    await expect(readSession()).resolves.toEqual(stored);
  });

  it.each([
    `secretprefix${SESSION}`,
    JSON.stringify({ session: 'bad;value', savedAt: 'x', method: 'browser' }),
    JSON.stringify({ session: SESSION, savedAt: 'x', method: 'other' }),
    'null',
  ])('형식이 깨지면 고정 메시지만 낸다 (입력을 담지 않음): %#', async (raw) => {
    get.mockResolvedValue(raw);
    const err = (await readSession().catch((e: unknown) => e)) as Error;
    expect(err.message).toBe('저장된 세션 형식이 올바르지 않습니다. logout 도구를 호출한 뒤 다시 login 하세요');
    expect(err.message).not.toContain('secret');
  });
});

describe('getSession 캐시', () => {
  const stored = { session: SESSION, savedAt: '2026-01-01T00:00:00.000Z', method: 'browser' };
  beforeEach(() => get.mockResolvedValue(JSON.stringify(stored)));

  it('한 번 읽은 세션은 키체인을 다시 읽지 않는다', async () => {
    await expect(getSession()).resolves.toEqual(stored);
    await expect(getSession()).resolves.toEqual(stored);
    expect(get).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['저장', () => saveSession(SESSION, 'browser')],
    ['삭제(logout)', () => deleteSession()],
    ['세션 만료', () => new SessionExpiredError()],
  ])('%s 하면 캐시를 비워 다시 읽는다', async (_, invalidate) => {
    await getSession();
    await invalidate();
    await getSession();
    expect(get).toHaveBeenCalledTimes(2);
  });

  it('세션이 없으면 기억하지 않아 다른 프로세스의 login 을 바로 읽는다', async () => {
    get.mockResolvedValueOnce(null);
    await expect(getSession()).rejects.toThrow('login 도구');
    await expect(getSession()).resolves.toEqual(stored);
    expect(get).toHaveBeenCalledTimes(2);
  });

  it('읽는 도중 저장되면 옛 값을 캐시에 넣지 않는다', async () => {
    let finish!: (v: string) => void;
    get.mockReturnValueOnce(new Promise((r) => (finish = r)));
    const pending = getSession();
    await saveSession(SESSION, 'extension');
    finish(JSON.stringify(stored));
    await pending;
    await getSession();
    expect(get).toHaveBeenCalledTimes(2);
  });
});
