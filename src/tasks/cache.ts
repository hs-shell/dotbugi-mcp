import { TASKS_CACHE_TTL_MS } from '../constants.js';
import { collectTasks, type CachedQuiz, type CollectResult } from './collect.js';
import { readCoursesConfig } from './courses.js';

interface Entry {
  session: string;
  // 강좌 추적 설정이 바뀌면 다른 결과다
  tracking: string;
  fetchedAt: number;
  result: Promise<CollectResult>;
}

// 프로세스 메모리 캐시. 진행 중인 요청도 공유해 동시 호출이 LMS 를 중복으로 긁지 않게 한다
let entry: Entry | null = null;
// 직전에 온전히 성공한 조회의 퀴즈 제출 상태 (dotbugi src/hooks/useCourseData.tsx cachedQuizMap 과 같은 용도)
let known: { session: string; quizzes: CachedQuiz[] } | null = null;

export async function getTaskItems(
  session: string,
  refresh: boolean,
  now = Date.now()
): Promise<{ fetchedAt: number } & CollectResult> {
  const config = readCoursesConfig();
  const tracking = JSON.stringify(config.courses);
  // 다른 세션(재로그인)이면 이전 계정 결과를 쓰지 않는다
  if (
    refresh ||
    !entry ||
    entry.session !== session ||
    entry.tracking !== tracking ||
    now - entry.fetchedAt >= TASKS_CACHE_TTL_MS
  ) {
    const cachedQuizzes = known?.session === session ? known.quizzes : undefined;
    const current: Entry = { session, tracking, fetchedAt: now, result: collectTasks(session, cachedQuizzes, config) };
    entry = current;
    const evict = () => {
      if (entry === current) entry = null;
    };
    current.result.then(({ items, failures }) => {
      // 일부가 빠진 결과는 이번 호출에만 돌려주고 캐시하지 않는다 (다음 호출이 다시 가져온다)
      if (failures > 0) return evict();
      const quizzes = items.filter((t) => t.type === 'quiz').map((t) => ({ url: t.url, isSubmit: t.done }));
      known = { session, quizzes };
    }, evict);
  }
  const { fetchedAt, result } = entry;
  return { fetchedAt, ...(await result) };
}
