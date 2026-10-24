import { afterEach, describe, expect, it, vi } from 'vitest';

const rename = vi.hoisted(() => vi.fn());
vi.mock('node:fs/promises', async (orig) => ({ ...(await orig<typeof import('node:fs/promises')>()), rename }));
const { replaceFile } = await import('../player/state.js');

const busy = () => Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' });
const setPlatform = (p: string) => Object.defineProperty(process, 'platform', { value: p });
const real = process.platform;

describe('replaceFile', () => {
  afterEach(() => {
    setPlatform(real);
    rename.mockReset();
  });

  it('Windows 에선 읽는 쪽 때문에 난 EPERM 을 다시 시도해 덮어쓴다', async () => {
    setPlatform('win32');
    rename.mockRejectedValueOnce(busy()).mockRejectedValueOnce(busy()).mockResolvedValueOnce(undefined);
    await replaceFile('a', 'b');
    expect(rename).toHaveBeenCalledTimes(3);
  });

  it('다른 OS 이거나 다른 오류면 바로 실패한다', async () => {
    setPlatform('linux');
    rename.mockRejectedValueOnce(busy());
    await expect(replaceFile('a', 'b')).rejects.toThrow('EPERM');
    setPlatform('win32');
    rename.mockRejectedValueOnce(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
    await expect(replaceFile('a', 'b')).rejects.toThrow('ENOENT');
    expect(rename).toHaveBeenCalledTimes(2);
  });
});
