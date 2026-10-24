import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readSession } from '../session.js';

const get = vi.fn();
vi.mock('../keychain/index.js', () => ({ getKeychain: () => ({ get }) }));

const SESSION = 'abcdefghij0123456789xyz';
beforeEach(() => get.mockReset());

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
