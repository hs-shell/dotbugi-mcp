import { TASKS_CACHE_TTL_MS } from '../constants.js';
import { collectTasks } from './collect.js';
import type { TaskItem } from './schema.js';

interface Entry {
  session: string;
  fetchedAt: number;
  items: Promise<TaskItem[]>;
}

// 프로세스 메모리 캐시. 진행 중인 요청도 공유해 동시 호출이 LMS 를 중복으로 긁지 않게 한다
let entry: Entry | null = null;

export async function getTaskItems(
  session: string,
  refresh: boolean,
  now = Date.now()
): Promise<{ fetchedAt: number; items: TaskItem[] }> {
  // 다른 세션(재로그인)이면 이전 계정 결과를 쓰지 않는다
  if (refresh || !entry || entry.session !== session || now - entry.fetchedAt >= TASKS_CACHE_TTL_MS) {
    const current: Entry = { session, fetchedAt: now, items: collectTasks(session, now) };
    entry = current;
    current.items.catch(() => {
      if (entry === current) entry = null;
    });
  }
  const { fetchedAt, items } = entry;
  return { fetchedAt, items: await items };
}
