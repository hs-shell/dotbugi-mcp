import { mkdtemp, mkdir, readdir, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { writePlayerState, type PlayerState } from '../player/state.js';

const state: PlayerState = {
  version: 1,
  status: 'playing',
  updatedAt: '2026-10-24T03:00:00.000Z',
  total: 2,
  index: 1,
  current: { course: '자료구조', title: 'A', week: 3, deadline: null, progress: 25, remainingSeconds: 900 },
  next: { course: '자료구조', title: 'B', week: 3, deadline: null },
  message: null,
};

let root: string;
beforeEach(async () => void (root = await mkdtemp(join(tmpdir(), 'player-state-'))));
afterEach(() => rm(root, { recursive: true, force: true }));

describe.skipIf(process.platform === 'win32')('writePlayerState', () => {
  it('0700 디렉터리에 0600 파일로, 임시 파일 없이 JSON 을 쓴다', async () => {
    const dir = join(root, 'cache', 'dotbugi-mcp');
    const file = join(dir, 'player-state.json');
    await writePlayerState(file, state);
    await writePlayerState(file, { ...state, index: 2 });
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ ...state, index: 2 });
    expect((await stat(dir)).mode & 0o777).toBe(0o700);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect(await readdir(dir)).toEqual(['player-state.json']);
  });

  it('이미 있던 넓은 권한 디렉터리는 0700 으로 좁힌다', async () => {
    const dir = join(root, 'shared');
    await mkdir(dir, { mode: 0o755 });
    await writePlayerState(join(dir, 'player-state.json'), state);
    expect((await stat(dir)).mode & 0o777).toBe(0o700);
  });
});
