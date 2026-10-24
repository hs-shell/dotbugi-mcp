import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { asrRemove } from '../tools/asr-remove.js';
import type { Asker } from '../tools/confirm.js';

let dir: string;
const root = () => join(dir, 'asr');
const lock = () => join(dir, 'transcribe.lock');
const installLock = () => join(dir, 'asr-install.lock');
const approve = (): Asker => ({
  caps: { elicitation: { form: {} } },
  elicit: vi.fn(async () => ({ action: 'accept' as const, content: { confirm: true } })),
});
const remove = (asker: Asker, token?: string) =>
  asrRemove(asker, token, root(), [
    [installLock(), '이미 ASR 설치가 실행 중'],
    [lock(), '받아쓰기가 실행 중'],
  ]);

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'dotbugi-asr-rm-'));
  await mkdir(join(root(), 'bin'), { recursive: true });
  await writeFile(join(root(), 'bin', 'ffmpeg'), 'x');
});
afterEach(() => rm(dir, { recursive: true, force: true }));

describe('asr_remove', () => {
  it('사용자가 승인하면 지운다', async () => {
    expect(await remove(approve())).toContain('삭제했습니다');
    expect(existsSync(root())).toBe(false);
  });

  it('승인하지 않으면 지우지 않는다', async () => {
    const asker: Asker = { caps: { elicitation: { form: {} } }, elicit: async () => ({ action: 'decline' }) };
    expect(await remove(asker)).toContain('승인하지 않아');
    expect(existsSync(root())).toBe(true);
  });

  it('확인 창이 없으면 토큰을 받은 두 번째 호출에서만 지운다', async () => {
    const asker: Asker = { caps: {}, elicit: async () => ({ action: 'accept' }) };
    const first = await remove(asker);
    expect(existsSync(root())).toBe(true);
    expect(await remove(asker, 'a'.repeat(64))).toContain('아무것도 지우지 않았습니다');
    expect(existsSync(root())).toBe(true);
    await remove(asker, /confirmToken: "([0-9a-f]+)"/.exec(first)![1]);
    expect(existsSync(root())).toBe(false);
  });

  it.each([
    ['받아쓰기', lock, '받아쓰기가 실행 중'],
    ['설치', installLock, '이미 ASR 설치가 실행 중'],
  ])('%s 작업이 잠금을 쥐고 있으면 승인해도 거절하고 다른 잠금도 남기지 않는다', async (_, file, busy) => {
    await writeFile(file(), String(process.pid));
    await expect(remove(approve())).rejects.toThrow(busy);
    expect(existsSync(root())).toBe(true);
    expect(existsSync(file === lock ? installLock() : lock())).toBe(false);
  });

  it('폴더가 링크면 링크만 지우고 대상은 남긴다', async () => {
    const real = join(dir, 'real');
    await mkdir(real);
    await writeFile(join(real, 'keep'), '중요');
    await rm(root(), { recursive: true });
    await symlink(real, root());
    await remove(approve());
    expect(existsSync(join(real, 'keep'))).toBe(true);
  });
});
