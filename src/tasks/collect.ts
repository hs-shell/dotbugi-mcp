import { parseCoursesFromDOM, scrapeCourseData, type CourseBase, type FetchHtml } from '@dotbugi/lms-parser';
import { LMS_COURSE_LIST_PATH, LMS_COURSE_LIST_SELECTOR, LMS_ORIGIN } from '../constants.js';
import { createFetchHtml } from '../lms-html.js';
import { SessionExpiredError } from '../lms.js';
import { log } from '../log.js';
import { itemKey, uniqueBy, vodKey } from './dedupe.js';
import type { TaskItem } from './schema.js';
import { clean } from './text.js';
import { splitRange, toIsoDeadline } from './time.js';

type CourseData = Awaited<ReturnType<typeof scrapeCourseData>>;
// 이전 조회의 퀴즈 제출 상태. 마감된 퀴즈는 상세 페이지 대신 이 값을 쓴다 (scrapeCourseData cachedQuizzes)
// TODO(hs-shell/dotbugi-lms-parser#5): 파서가 마감 여부를 실행 환경 시간대로 판정한다 — KST 가 아닌 환경에선 재사용 시점이 어긋난다
export type CachedQuiz = { url: string; isSubmit: boolean };

export interface CollectResult {
  items: TaskItem[];
  // 실패한 LMS 요청 수. 0 보다 크면 결과가 불완전하다
  failures: number;
}

// "mm:ss" 또는 "hh:mm:ss" → 초 (@dotbugi/lms-parser fetchVodProgress.ts 와 같은 규칙)
function toSeconds(time: string): number {
  const parts = time.split(':').map(Number);
  return parts.reduce((acc, n) => acc * 60 + n, 0);
}

// dotbugi src/lib/attendance.ts isAttended
const isAttended = (value: string) => value.toLowerCase().trim() === 'o';

function vodStatus(attended: boolean, required?: string, watched?: string): string {
  if (attended) return '출석';
  if (!required || !watched || toSeconds(required) === 0) return '미출석';
  return `미출석 (진도 ${Math.min(100, Math.floor((toSeconds(watched) / toSeconds(required)) * 100))}%)`;
}

// LMS 가 준 링크라도 LMS 출처가 아니면 내보내지 않는다
function lmsUrl(url: string): string {
  try {
    return new URL(url).origin === LMS_ORIGIN ? url : '';
  } catch {
    return '';
  }
}

// dotbugi src/lib/transformCourseData.ts mergeVodWithAttendance(제목+주차로 출석 조인, 출석 정보 없는 VOD 제외)
// 기간·마감 필터는 조회 시점에 selectTasks 가 한다 (캐시가 1시간 내내 맞도록, 지난 퀴즈는 cachedQuizzes 로 재사용)
export function toTaskItems(course: CourseBase, data: CourseData): TaskItem[] {
  const courseTitle = clean(course.courseTitle);
  const attendance = new Map(data.vodAttendanceArray.map((a) => [`${a.title}-${a.week}`, a]));
  const vods = uniqueBy(data.vodDataArray, (v) => vodKey(course.courseId, v)).flatMap((vod): TaskItem[] => {
    const att = attendance.get(`${vod.title}-${vod.week}`);
    if (!att) return [];
    const [start, deadline] = splitRange(vod.range).map(toIsoDeadline);
    const done = isAttended(att.isAttendance);
    const status = vodStatus(done, att.requiredTime, att.watchedTime);
    return [
      {
        type: 'vod',
        course: courseTitle,
        title: clean(vod.title),
        done,
        status,
        start,
        deadline,
        url: lmsUrl(vod.url),
      },
    ];
  });
  const items = (type: 'assign' | 'quiz', list: CourseData['assignDataArray'], labels: [string, string]) =>
    uniqueBy(list, (i) => itemKey(course.courseId, i)).map((item): TaskItem => ({
      type,
      course: courseTitle,
      title: clean(item.title),
      done: item.isSubmit,
      status: item.isSubmit ? labels[0] : labels[1],
      start: null,
      deadline: toIsoDeadline(item.dueDate),
      url: lmsUrl(item.url),
    }));
  return [
    ...vods,
    ...items('assign', data.assignDataArray, ['제출', '미제출']),
    ...items('quiz', data.quizDataArray, ['응시', '미응시']),
  ];
}

// 내 강좌 목록 → 과목별 스크래핑. dotbugi src/hooks/useGetCourses.ts 처럼 비교과(커뮤니티) 과목은 제외한다
export async function collectTasks(session: string, cachedQuizzes?: CachedQuiz[]): Promise<CollectResult> {
  // 파서는 개별 요청 실패를 빈 값으로 삼킨다(퀴즈 상세 실패는 onError 로도 안 올라오고 '미응시'가 된다).
  // 그래서 모든 요청이 지나는 여기서 실패 수와 세션 만료를 직접 센다
  let expired = false;
  let failures = 0;
  const baseFetch = createFetchHtml(session);
  const fetchHtml: FetchHtml = (url) =>
    baseFetch(url).catch((err: unknown) => {
      if (err instanceof SessionExpiredError) expired = true;
      failures++;
      throw err;
    });

  const page = await fetchHtml(LMS_COURSE_LIST_PATH);
  // 목록 컨테이너가 없으면 '과목 0개'가 아니라 다른 페이지를 받은 것이다
  if (!page.querySelector(LMS_COURSE_LIST_SELECTOR))
    throw new Error('LMS 메인에서 내 강좌 목록을 찾지 못했습니다. LMS 화면 구조가 바뀌었을 수 있습니다.');
  // 같은 과목이 목록에 여러 번 나와도 한 번만 긁는다
  const courses = uniqueBy(
    parseCoursesFromDOM(page).filter((c) => !c.isCommunity),
    (c) => c.courseId
  );
  let failedCourses = 0;
  const perCourse = await Promise.all(
    courses.map((course) =>
      scrapeCourseData(fetchHtml, course.courseId, { cachedQuizzes }).then(
        (data) => toTaskItems(course, data),
        () => {
          failedCourses++;
          return [];
        }
      )
    )
  );
  if (expired) throw new SessionExpiredError();
  if (failedCourses > 0 && failedCourses === courses.length)
    throw new Error('LMS 에서 과목 정보를 가져오지 못했습니다.');
  if (failures > 0) log(`LMS 요청 ${failures}건이 실패해 일부 과목·항목이 빠졌을 수 있습니다.`);
  return { items: perCourse.flat(), failures };
}
