import { mkdtemp, mkdir, readdir, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as z from 'zod/v4';
import { PLAYER_STATE_TEXT_MAX } from '../constants.js';
import { stateText, writeStateFile } from '../player/state.js';

const schema = z.object({ index: z.number(), message: stateText.nullable(), title: stateText });
type State = z.infer<typeof schema>;
const state: State = { index: 1, message: null, title: 'A' };
const write = (file: string, value: State) => writeStateFile(file, schema, value);

let root: string;
beforeEach(async () => void (root = await mkdtemp(join(tmpdir(), 'player-state-'))));
afterEach(() => rm(root, { recursive: true, force: true }));

describe.skipIf(process.platform === 'win32')('writeStateFile', () => {
  it('0700 디렉터리에 0600 파일로, 임시 파일 없이 JSON 을 쓴다', async () => {
    const dir = join(root, 'cache', 'dotbugi-mcp');
    const file = join(dir, 'player-state.json');
    await write(file, state);
    await write(file, { ...state, index: 2 });
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ ...state, index: 2 });
    expect((await stat(dir)).mode & 0o777).toBe(0o700);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect(await readdir(dir)).toEqual(['player-state.json']);
  });

  it('긴 글은 잘라서 써 상태 파일이 읽기 상한을 넘지 않게 한다', async () => {
    const file = join(root, 'player-state.json');
    const long = '가'.repeat(PLAYER_STATE_TEXT_MAX * 10);
    await write(file, { ...state, message: long, title: long });
    const saved = JSON.parse(await readFile(file, 'utf8')) as State;
    expect(saved.message).toHaveLength(PLAYER_STATE_TEXT_MAX);
    expect(saved.title).toHaveLength(PLAYER_STATE_TEXT_MAX);
  });

  it('이미 있던 넓은 권한 디렉터리는 0700 으로 좁힌다', async () => {
    const dir = join(root, 'shared');
    await mkdir(dir, { mode: 0o755 });
    await write(join(dir, 'player-state.json'), state);
    expect((await stat(dir)).mode & 0o777).toBe(0o700);
  });
});
