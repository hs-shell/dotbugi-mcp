import type { ListTasksInput, Task, TaskItem } from './schema.js';
import { LMS_NUMERIC_ID, LMS_ORIGIN } from '../constants.js';
import { deadlineMs, formatRemaining } from './time.js';

const MS_PER_DAY = 24 * 60 * 60_000;

// 마감 정보가 없거나 해석할 수 없으면 맨 뒤 (Infinity - Infinity = NaN 은 || 0 으로 동순위 처리)
function sortKey(t: TaskItem): number {
  const ms = deadlineMs(t.deadline);
  return Number.isNaN(ms) ? Infinity : ms;
}

// LMS 출처 주소의 숫자 id= 만 cmid 로 쓴다 (다른 도구 인자로 그대로 넘어가므로 형식을 고정)
export function cmidOfUrl(url: string): number | null {
  try {
    const u = new URL(url);
    const id = u.searchParams.get('id') ?? '';
    return u.origin === LMS_ORIGIN && LMS_NUMERIC_ID.test(id) ? Number(id) : null;
  } catch {
    return null;
  }
}

// 캐시된 항목에 사용자 필터를 적용하고 마감 임박 순(마감 정보 없음은 뒤)으로 정렬한다
export function selectTasks(
  items: TaskItem[],
  input: Omit<ListTasksInput, 'refresh' | 'includePast'> & { includePast?: boolean },
  now: number
): Task[] {
  const course = input.course?.toLowerCase();
  const limit = input.withinDays === undefined ? undefined : now + input.withinDays * MS_PER_DAY;
  return (
    items
      .filter((t) => {
        const ms = deadlineMs(t.deadline);
        const overdue = !t.done && ms < now;
        // 캐시 이후 지난 마감은 뺀다. includePast 면 놓친(미완료) 것만 남긴다
        if (ms < now && !(input.includePast && overdue)) return false;
        // VOD 는 출석 인정 기간 안(시작 ≤ 지금 ≤ 종료)인 것만 — 조회 시점에 걸러야 캐시된 1시간 동안에도 맞다
        // (dotbugi src/hooks/useCourseData.tsx filterVodsForDisplay). 위에서 남긴 지난 VOD 는 종료 조건만 면제
        if (t.type === 'vod' && !(deadlineMs(t.start) <= now && (overdue || now <= ms))) return false;
        if (input.type && t.type !== input.type) return false;
        if (input.incompleteOnly && t.done) return false;
        if (course && !t.course.toLowerCase().includes(course)) return false;
        if (limit !== undefined && !(ms <= limit)) return false;
        return true;
      })
      // 지난 마감은 지금보다 앞이라 마감 순 정렬만으로 overdue 가 맨 앞에 온다
      .sort((a, b) => sortKey(a) - sortKey(b) || 0)
      // 스케줄러 내부용 vod 는 undefined 로 덮어 응답(JSON)에서 뺀다
      .map((t) => ({
        ...t,
        vod: undefined,
        remaining: formatRemaining(t.deadline, now),
        cmid: cmidOfUrl(t.url),
        overdue: !t.done && deadlineMs(t.deadline) < now,
      }))
  );
}
