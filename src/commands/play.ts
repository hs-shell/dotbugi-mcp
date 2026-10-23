import { setTimeout as sleep } from 'node:timers/promises';
import { SIGNAL_EXIT_CODES } from '../constants.js';
import { acquireLock } from '../player/lock.js';
import { openApp } from '../player/open-app.js';
import { createProgressFetcher } from '../player/progress.js';
import { playVods, selectTargets } from '../player/scheduler.js';
import { PLAYER_LOCK_FILE, PLAYER_STATE_FILE, writePlayerState } from '../player/state.js';
import { getSession } from '../session.js';
import { collectTasks } from '../tasks/collect.js';

type StopSignal = keyof typeof SIGNAL_EXIT_CODES;
const STOP_SIGNALS = Object.keys(SIGNAL_EXIT_CODES) as StopSignal[];

// 포그라운드 실행 — 사용자가 Ctrl+C 로 멈출 때까지 마감 임박 순으로 VOD 를 연다
export async function play(): Promise<void> {
  const { session } = await getSession();
  const release = await acquireLock(PLAYER_LOCK_FILE);
  const controller = new AbortController();
  const stop = (signal: StopSignal) => {
    // 셸 관례대로 시그널 종료 코드로 끝낸다 (잠금 해제·상태 기록은 아래 finally 까지 마친다)
    process.exitCode = SIGNAL_EXIT_CODES[signal];
    controller.abort();
  };
  for (const s of STOP_SIGNALS) process.once(s, stop);
  try {
    const { items } = await collectTasks(session);
    if (controller.signal.aborted) return;
    await playVods(
      selectTargets(items, Date.now()),
      {
        now: Date.now,
        sleep: (ms) => sleep(ms, undefined, { signal: controller.signal }),
        fetchProgress: createProgressFetcher(session),
        open: openApp,
        save: (state) => writePlayerState(PLAYER_STATE_FILE, state),
      },
      controller.signal
    );
  } finally {
    for (const s of STOP_SIGNALS) process.off(s, stop);
    await release();
  }
}
