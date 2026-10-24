import { randomUUID } from 'node:crypto';
import { closeSync, constants, fstatSync, openSync, readFileSync } from 'node:fs';
import { chmod, mkdir, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import * as z from 'zod/v4';
import { PLAYER_STATE_MAX_BYTES, PLAYER_STATE_TEXT_MAX } from '../constants.js';

export const PLAYER_STATE_FILE = join(homedir(), '.cache', 'dotbugi-mcp', 'player-state.json');
export const PLAYER_LOCK_FILE = join(dirname(PLAYER_STATE_FILE), 'player.lock');

// 상태 파일은 다른 프로세스가 쓴 디스크 데이터라 읽을 때 이 스키마로 검증한다.
// 긴 글은 거부하지 않고 자른다 (쓸 때도 같은 스키마로 잘라 PLAYER_STATE_MAX_BYTES 안에 들게 — 7개 × 200자)
export const stateText = z.string().overwrite((s) => s.slice(0, PLAYER_STATE_TEXT_MAX));
const text = stateText;
const playerVod = z.object({
  course: text,
  title: text,
  week: z.number().int(),
  // 출석 인정 종료 (오프셋 포함 ISO)
  deadline: text.nullable(),
});
export type PlayerVod = z.infer<typeof playerVod>;

// 상태 표시줄(#6)이 읽는 표시용 데이터만 담는다 — 세션·URL·LMS 식별자는 넣지 않는다.
// 강제 종료되면 status 가 playing 으로 남으므로 updatedAt 이 PLAYER_STATE_STALE_MS(constants)보다 오래되면 멈춘 것으로 본다
export const playerStateSchema = z.object({
  version: z.literal(1),
  status: z.enum(['playing', 'done', 'stopped', 'error']),
  updatedAt: z.iso.datetime(),
  total: z.number().int().nonnegative(),
  // 지금 강의 순번 (1부터, 없으면 0)
  index: z.number().int().nonnegative(),
  current: playerVod
    .extend({ progress: z.number().min(0).max(100).nullable(), remainingSeconds: z.number().nonnegative().nullable() })
    .nullable(),
  next: playerVod.nullable(),
  message: text.nullable(),
  // 쓴 재생 프로세스 — stop_vods 가 잠금의 pid 와 맞춰 보고 우리 재생 작업일 때만 신호를 보낸다 (이전 버전 파일엔 없음)
  pid: z.number().int().positive().optional(),
});
export type PlayerState = z.infer<typeof playerStateSchema>;

// 강의 목록을 모으기 전(또는 그 단계에서 끝날 때)의 상태
export const idleState = (status: PlayerState['status'], pid: number, message: string | null = null): PlayerState => ({
  version: 1,
  status,
  updatedAt: new Date().toISOString(),
  total: 0,
  index: 0,
  current: null,
  next: null,
  message,
  pid,
});

// 상태 표시줄이 자주 부르므로 동기로 읽는다. 링크를 따라가지 않고(O_NOFOLLOW), FIFO 에 막히지 않으며(O_NONBLOCK),
// 정규 파일·크기 상한·스키마를 통과한 것만 돌려준다. 없거나 이상하면 null
export function readPlayerState(file: string): PlayerState | null {
  return readStateFile(file, playerStateSchema);
}

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

// 읽는 쪽이 쓰다 만 파일을 보지 않게 임시 파일에 쓰고 rename 한다. 디렉터리 0700, 파일 0600
export function writePlayerState(file: string, state: PlayerState): Promise<void> {
  return writeStateFile(file, playerStateSchema, state);
}

export async function writeStateFile<T>(file: string, schema: z.ZodType<T>, state: T): Promise<void> {
  await ensurePrivateDir(dirname(file));
  // 같은 프로세스가 동시에 써도 서로의 임시 파일을 옮기지 않게 이름을 매번 다르게
  const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(tmp, `${JSON.stringify(schema.parse(state), null, 2)}\n`, { mode: 0o600 });
  await rename(tmp, file);
}
