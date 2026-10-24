import { spawn } from 'node:child_process';
import { readFile, rename, writeFile } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { acquireLock, isAlive } from '../player/lock.js';
import { idleState, PLAYER_LOCK_FILE, PLAYER_STATE_FILE, readPlayerState, writePlayerState } from '../player/state.js';
import { redact } from '../redact.js';
import { getSession } from '../session.js';

// dist/tools/ → dist/index.js
const ENTRY = fileURLToPath(new URL('../index.js', import.meta.url));
const PLAYER_BUSY = '이미 VOD 를 재생 중입니다. 진행은 vod_status, 중지는 stop_vods 로 하세요.';

const WORKER_DEPS = { spawn, getSession };

// 재생은 몇 시간 걸린다 — transcribe_vod 처럼 따로 떠 있는 작업 프로세스(셸 없이 인자 배열)로 넘기고 바로 돌아온다.
// 이미 재생 중이면 false (오류가 아니라 안내)
export async function startPlayer(deps = WORKER_DEPS): Promise<boolean> {
  await deps.getSession();
  let release;
  try {
    release = await acquireLock(PLAYER_LOCK_FILE, PLAYER_BUSY);
  } catch (err) {
    if (err instanceof Error && err.message === PLAYER_BUSY) return false;
    throw err;
  }
  try {
    const child = deps.spawn(process.execPath, [ENTRY, 'play', '--worker'], { detached: true, stdio: 'ignore' });
    await new Promise<void>((resolve, reject) => {
      child.once('spawn', resolve);
      child.once('error', reject);
    });
    // 잠금 파일의 pid 를 작업 프로세스로 바꾼다 — 임시 파일 + rename (transcribe_vod 와 같은 이유)
    const tmp = `${PLAYER_LOCK_FILE}.${process.pid}.tmp`;
    await writeFile(tmp, String(child.pid), { mode: 0o600 });
    await rename(tmp, PLAYER_LOCK_FILE);
    child.unref();
    // 시작 직후 vod_status 가 이전 재생 상태를 보여주지 않게 바로 기록한다 (작업 프로세스가 이어서 갱신)
    await writePlayerState(PLAYER_STATE_FILE, idleState('playing', child.pid!)).catch(() => {});
    return true;
  } catch (err) {
    await release();
    throw err;
  }
}

const readLockPid = async () => Number((await readFile(PLAYER_LOCK_FILE, 'utf8').catch(() => '')).trim());

const STOP_DEPS = {
  kill: (pid: number, signal: NodeJS.Signals) => void process.kill(pid, signal),
  isAlive,
  timeoutMs: 5000,
};

// 잠금의 pid 가 살아 있고, 상태 파일도 같은 pid 로 재생 중일 때만 SIGTERM 을 보낸다 — pid 재사용·다른 프로세스를 죽이지 않게.
// Windows 에선 SIGTERM 이 곧바로 강제 종료라 상태가 stopped 로 바뀌지 않을 수 있다
export async function stopPlayer(deps = STOP_DEPS): Promise<string> {
  const pid = await readLockPid();
  if (!Number.isInteger(pid) || pid <= 0 || !deps.isAlive(pid)) return '재생 중인 VOD 가 없습니다.';
  const state = readPlayerState(PLAYER_STATE_FILE);
  if (pid === process.pid || state?.status !== 'playing' || state.pid !== pid)
    return '재생 작업을 확인하지 못해 중지하지 않았습니다. 터미널에서 실행한 play 라면 그 터미널에서 Ctrl+C 로 멈추세요.';
  deps.kill(pid, 'SIGTERM');
  // 작업 프로세스가 상태를 stopped 로 쓰고 잠금을 풀 때까지 잠시 기다린다
  for (const end = Date.now() + deps.timeoutMs; Date.now() < end; await sleep(100))
    if ((await readLockPid()) !== pid) return '재생을 중지했습니다. 열린 강의 창은 직접 닫아 주세요.';
  return '중지 신호를 보냈지만 아직 끝나지 않았습니다. 잠시 뒤 vod_status 로 확인하세요.';
}

const errorResult = (err: unknown) => ({
  content: [{ type: 'text' as const, text: redact(err instanceof Error ? err.message : String(err)) }],
  isError: true,
});

export function registerPlayVods(server: McpServer): void {
  server.registerTool(
    'play_vods',
    {
      title: 'VOD 연속 재생 시작',
      description:
        '미출석 VOD 를 마감 임박 순으로 LMS 공식 플레이어 창(평소 브라우저)에 하나씩 여는 백그라운드 재생을 시작하고 바로 돌아온다. ' +
        '서버가 출석(진도 100%)을 확인해야 다음 강의를 연다. 출석은 공식 플레이어 재생으로만 인정되며 헤드리스·음소거·배속 강제는 하지 않는다. ' +
        '진행은 vod_status, 중지는 stop_vods. 대상 강좌는 dotbugi-mcp courses 설정을 따른다.',
      inputSchema: z.object({}),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async () => {
      try {
        const text = (await startPlayer())
          ? 'VOD 연속 재생을 시작했습니다. 마감 임박 순으로 공식 플레이어 창이 열리며, 다 본 창은 직접 닫아 주세요. ' +
            '진행은 vod_status, 중지는 stop_vods 로 하세요.'
          : PLAYER_BUSY;
        return { content: [{ type: 'text', text }] };
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  server.registerTool(
    'stop_vods',
    {
      title: 'VOD 연속 재생 중지',
      description: 'play_vods(또는 dotbugi-mcp play)로 재생 중인 VOD 연속 재생을 멈춘다. 열린 강의 창은 닫지 않는다.',
      inputSchema: z.object({}),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async () => {
      try {
        return { content: [{ type: 'text', text: await stopPlayer() }] };
      } catch (err) {
        return errorResult(err);
      }
    }
  );
}
