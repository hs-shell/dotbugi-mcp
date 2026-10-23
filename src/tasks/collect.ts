import { parseCoursesFromDOM, scrapeCourseData, type CourseBase, type FetchHtml } from '@dotbugi/lms-parser';
import { LMS_COURSE_LIST_PATH } from '../constants.js';
import { createFetchHtml } from '../lms-html.js';
import { SessionExpiredError } from '../lms.js';
import { log } from '../log.js';
import type { TaskItem } from './schema.js';
import { deadlineMs, splitRange, toIsoDeadline } from './time.js';

type CourseData = Awaited<ReturnType<typeof scrapeCourseData>>;

// LMS 텍스트는 데이터일 뿐이다 — 줄바꿈·제어문자를 공백 하나로 접어 평범한 한 줄 문자열로만 넘긴다
const clean = (text: string) => text.replace(/[\s\p{Cc}]+/gu, ' ').trim();

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

// dotbugi src/lib/transformCourseData.ts mergeVodWithAttendance(제목+주차로 출석 조인, 출석 정보 없는 VOD 제외)
// + src/hooks/useCourseData.tsx filterVodsForDisplay·filterItemsForDisplay(지금 진행 중·마감 전 항목만)
export function toTaskItems(course: CourseBase, data: CourseData, now: number): TaskItem[] {
  const courseTitle = clean(course.courseTitle);
  const attendance = new Map(data.vodAttendanceArray.map((a) => [`${a.title}-${a.week}`, a]));
  const vods = data.vodDataArray.flatMap((vod): TaskItem[] => {
    const att = attendance.get(`${vod.title}-${vod.week}`);
    const [start, end] = splitRange(vod.range).map(toIsoDeadline);
    if (!att || !(deadlineMs(start) <= now && now <= deadlineMs(end))) return [];
    const done = isAttended(att.isAttendance);
    const status = vodStatus(done, att.requiredTime, att.watchedTime);
    return [{ type: 'vod', course: courseTitle, title: clean(vod.title), done, status, deadline: end, url: vod.url }];
  });
  const items = (type: 'assign' | 'quiz', list: CourseData['assignDataArray'], labels: [string, string]) =>
    list.flatMap((item): TaskItem[] => {
      const deadline = toIsoDeadline(item.dueDate);
      if (deadline && deadlineMs(deadline) < now) return [];
      const status = item.isSubmit ? labels[0] : labels[1];
      return [
        { type, course: courseTitle, title: clean(item.title), done: item.isSubmit, status, deadline, url: item.url },
      ];
    });
  return [
    ...vods,
    ...items('assign', data.assignDataArray, ['제출', '미제출']),
    ...items('quiz', data.quizDataArray, ['응시', '미응시']),
  ];
}

// 내 강좌 목록 → 과목별 스크래핑. dotbugi src/hooks/useGetCourses.ts 처럼 비교과(커뮤니티) 과목은 제외한다
export async function collectTasks(session: string, now = Date.now()): Promise<TaskItem[]> {
  // 파서가 개별 요청 실패를 삼키므로(빈 값으로 대체) 세션 만료는 여기서 따로 기록해 둔다
  let expired = false;
  const baseFetch = createFetchHtml(session);
  const fetchHtml: FetchHtml = (url) =>
    baseFetch(url).catch((err: unknown) => {
      if (err instanceof SessionExpiredError) expired = true;
      throw err;
    });

  const courses = parseCoursesFromDOM(await fetchHtml(LMS_COURSE_LIST_PATH)).filter((c) => !c.isCommunity);
  let failed = 0;
  const perCourse = await Promise.all(
    courses.map((course) =>
      scrapeCourseData(fetchHtml, course.courseId).then(
        (data) => toTaskItems(course, data, now),
        () => {
          failed++;
          return [];
        }
      )
    )
  );
  if (expired) throw new SessionExpiredError();
  if (failed > 0 && failed === courses.length) throw new Error('LMS 에서 과목 정보를 가져오지 못했습니다.');
  if (failed > 0) log(`과목 ${failed}개의 정보를 가져오지 못해 제외했습니다.`);
  return perCourse.flat();
}
