import { chmod, mkdir, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export const PLAYER_STATE_FILE = join(homedir(), '.cache', 'dotbugi-mcp', 'player-state.json');

export interface PlayerVod {
  course: string;
  title: string;
  week: number;
  // 출석 인정 종료 (오프셋 포함 ISO)
  deadline: string | null;
}

// 상태 표시줄(#6)이 읽는 표시용 데이터만 담는다 — 세션·URL·LMS 식별자는 넣지 않는다
export interface PlayerState {
  version: 1;
  status: 'playing' | 'done' | 'stopped' | 'error';
  updatedAt: string;
  total: number;
  // 지금 강의 순번 (1부터, 없으면 0)
  index: number;
  current: (PlayerVod & { progress: number | null; remainingSeconds: number | null }) | null;
  next: PlayerVod | null;
  message: string | null;
}

// 읽는 쪽이 쓰다 만 파일을 보지 않게 임시 파일에 쓰고 rename 한다. 디렉터리 0700, 파일 0600
export async function writePlayerState(file: string, state: PlayerState): Promise<void> {
  const dir = dirname(file);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  // 이미 있던 디렉터리는 mkdir mode 가 적용되지 않는다
  await chmod(dir, 0o700);
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  await rename(tmp, file);
}
