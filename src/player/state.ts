import { randomUUID } from 'node:crypto';
import { closeSync, constants, fstatSync, openSync, readFileSync } from 'node:fs';
import { chmod, mkdir, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import * as z from 'zod/v4';
import { PLAYER_STATE_MAX_BYTES, PLAYER_STATE_TEXT_MAX } from '../constants.js';

export const PLAYER_STATE_FILE = join(homedir(), '.cache', 'dotbugi-mcp', 'player-state.json');

// 상태 파일은 다른 프로세스가 쓴 디스크 데이터라 읽을 때 스키마로 검증한다.
// 긴 글은 거부하지 않고 자른다 (쓸 때도 같은 스키마로 잘라 PLAYER_STATE_MAX_BYTES 안에 들게)
export const stateText = z.string().overwrite((s) => s.slice(0, PLAYER_STATE_TEXT_MAX));

// 링크를 따라가지 않고(O_NOFOLLOW), FIFO 에 막히지 않으며(O_NONBLOCK),
// 정규 파일·크기 상한·스키마를 통과한 것만 돌려준다. 없거나 이상하면 null
export function readStateFile<T>(file: string, schema: z.ZodType<T>): T | null {
  let fd: number | undefined;
  try {
    fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    const st = fstatSync(fd);
    if (!st.isFile() || st.size > PLAYER_STATE_MAX_BYTES) return null;
    const parsed = schema.safeParse(JSON.parse(readFileSync(fd, 'utf8')));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

export async function ensurePrivateDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  // 이미 있던 디렉터리는 mkdir mode 가 적용되지 않는다
  await chmod(dir, 0o700);
}

// Windows 는 다른 프로세스가 대상 파일을 읽는 순간 rename 덮어쓰기가 EPERM/EACCES/EBUSY 로 실패한다 — 잠시 뒤 다시 시도한다
const RETRY_CODES = new Set(['EPERM', 'EACCES', 'EBUSY']);
export async function replaceFile(from: string, to: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await rename(from, to);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code ?? '';
      if (process.platform !== 'win32' || !RETRY_CODES.has(code) || attempt >= 20) throw err;
      await new Promise((r) => setTimeout(r, 10 + attempt * 10));
    }
  }
}

// 읽는 쪽이 쓰다 만 파일을 보지 않게 임시 파일에 쓰고 rename 한다. 디렉터리 0700, 파일 0600
export async function writeStateFile<T>(file: string, schema: z.ZodType<T>, state: T): Promise<void> {
  await ensurePrivateDir(dirname(file));
  // 같은 프로세스가 동시에 써도 서로의 임시 파일을 옮기지 않게 이름을 매번 다르게
  const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(tmp, `${JSON.stringify(schema.parse(state), null, 2)}\n`, { mode: 0o600 });
  await replaceFile(tmp, file);
}
