import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { acquireLock } from '../player/lock.js';

let root: string;
let file: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'player-lock-'));
  file = join(root, 'cache', 'player.lock');
});
afterEach(() => rm(root, { recursive: true, force: true }));

describe('acquireLock', () => {
  it('pid 를 담은 잠금을 만들고, 해제하면 지운다', async () => {
    const release = await acquireLock(file);
    expect(await readFile(file, 'utf8')).toBe(String(process.pid));
    if (process.platform !== 'win32') expect((await stat(file)).mode & 0o777).toBe(0o600);
    await release();
    await expect(stat(file)).rejects.toThrow();
  });

  it('살아 있는 프로세스가 잡고 있으면 거부한다', async () => {
    const release = await acquireLock(file);
    await expect(acquireLock(file)).rejects.toThrow('이미 play 가 실행 중입니다');
    await release();
  });

  it.each(['999999999', 'garbage', ''])('죽은(또는 알 수 없는) pid 의 잠금은 넘겨받는다: %j', async (content) => {
    await acquireLock(file);
    await writeFile(file, content);
    const release = await acquireLock(file);
    expect(await readFile(file, 'utf8')).toBe(String(process.pid));
    await release();
  });
});
