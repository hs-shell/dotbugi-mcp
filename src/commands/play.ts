import { setTimeout as sleep } from 'node:timers/promises';
import { openApp } from '../player/open-app.js';
import { createProgressFetcher } from '../player/progress.js';
import { playVods, selectTargets } from '../player/scheduler.js';
import { PLAYER_STATE_FILE, writePlayerState } from '../player/state.js';
import { getSession } from '../session.js';
import { collectTasks } from '../tasks/collect.js';

// 포그라운드 실행 — 사용자가 Ctrl+C 로 멈출 때까지 마감 임박 순으로 VOD 를 연다
export async function play(): Promise<void> {
  const { session } = await getSession();
  const { items } = await collectTasks(session);
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once('SIGINT', stop).once('SIGTERM', stop);
  try {
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
    process.off('SIGINT', stop).off('SIGTERM', stop);
  }
}
