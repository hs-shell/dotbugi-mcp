import type { ListTasksInput, Task, TaskItem } from './schema.js';
import { deadlineMs, formatRemaining } from './time.js';

const MS_PER_DAY = 24 * 60 * 60_000;

// 마감 정보가 없거나 해석할 수 없으면 맨 뒤 (Infinity - Infinity = NaN 은 || 0 으로 동순위 처리)
function sortKey(t: TaskItem): number {
  const ms = deadlineMs(t.deadline);
  return Number.isNaN(ms) ? Infinity : ms;
}

// 캐시된 항목에 사용자 필터를 적용하고 마감 임박 순(마감 정보 없음은 뒤)으로 정렬한다
export function selectTasks(items: TaskItem[], input: Omit<ListTasksInput, 'refresh'>, now: number): Task[] {
  const course = input.course?.toLowerCase();
  const limit = input.withinDays === undefined ? undefined : now + input.withinDays * MS_PER_DAY;
  return items
    .filter((t) => {
      const ms = deadlineMs(t.deadline);
      // 캐시 이후 지난 마감은 뺀다
      if (ms < now) return false;
      if (input.type && t.type !== input.type) return false;
      if (input.incompleteOnly && t.done) return false;
      if (course && !t.course.toLowerCase().includes(course)) return false;
      if (limit !== undefined && !(ms <= limit)) return false;
      return true;
    })
    .sort((a, b) => sortKey(a) - sortKey(b) || 0)
    .map((t) => ({ ...t, remaining: formatRemaining(t.deadline, now) }));
}
