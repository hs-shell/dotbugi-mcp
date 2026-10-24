import { setTimeout as sleep } from 'node:timers/promises';
import { SIGNAL_EXIT_CODES } from '../constants.js';
import { acquireLock, adoptLock } from '../player/lock.js';
import { openApp } from '../player/open-app.js';
import { createProgressFetcher } from '../player/progress.js';
import { playVods, selectTargets } from '../player/scheduler.js';
import { idleState, PLAYER_LOCK_FILE, PLAYER_STATE_FILE, writePlayerState, type PlayerState } from '../player/state.js';
import { redact } from '../redact.js';
import { getSession } from '../session.js';
import { collectTasks } from '../tasks/collect.js';

type StopSignal = keyof typeof SIGNAL_EXIT_CODES;
const STOP_SIGNALS = Object.keys(SIGNAL_EXIT_CODES) as StopSignal[];

// 마감 임박 순으로 VOD 를 연다. 포그라운드 CLI 는 Ctrl+C 로, play_vods 가 띄운 백그라운드 작업(worker: 잠금은 도구가 넘겨준다)은
// stop_vods 의 SIGTERM 으로 멈춘다
export async function play(worker = false): Promise<void> {
  const { session } = await getSession();
  const release = worker ? await adoptLock(PLAYER_LOCK_FILE) : await acquireLock(PLAYER_LOCK_FILE);
  const controller = new AbortController();
  const stop = (signal: StopSignal) => {
    // 셸 관례대로 시그널 종료 코드로 끝낸다 (잠금 해제·상태 기록은 아래 finally 까지 마친다)
    process.exitCode = SIGNAL_EXIT_CODES[signal];
    controller.abort();
  };
  for (const s of STOP_SIGNALS) process.once(s, stop);
  // stop_vods 가 잠금의 pid 와 맞춰 볼 수 있게 상태마다 내 pid 를 남긴다
  const save = (state: PlayerState) => writePlayerState(PLAYER_STATE_FILE, { ...state, pid: process.pid });
  try {
    // 강의 목록을 모으는 동안에도 재생 중으로 보이고 중지할 수 있게
    await save(idleState('playing', process.pid)).catch(() => {});
    let items;
    try {
      ({ items } = await collectTasks(session));
    } catch (err) {
      const message = redact(err instanceof Error ? err.message : String(err), [session]);
      await save(idleState('error', process.pid, message)).catch(() => {});
      throw new Error(message);
    }
    if (controller.signal.aborted) return void (await save(idleState('stopped', process.pid)).catch(() => {}));
    await playVods(
      selectTargets(items, Date.now()),
      {
        now: Date.now,
        sleep: (ms) => sleep(ms, undefined, { signal: controller.signal }),
        fetchProgress: createProgressFetcher(session),
        open: openApp,
        save,
      },
      controller.signal
    );
  } finally {
    for (const s of STOP_SIGNALS) process.off(s, stop);
    await release();
  }
}
