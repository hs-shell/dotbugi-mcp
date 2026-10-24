import { getIndexPageLink, type FetchHtml } from '@dotbugi/lms-parser';
import { AVAILABILITY_INFO_MAX_CHARS, LMS_NUMERIC_ID, LMS_ORIGIN } from '../constants.js';
import { SessionExpiredError } from '../lms.js';
import { weekName } from '../materials/course-page.js';
import { listCourses } from '../tasks/collect.js';
import { cmidOfUrl } from '../tasks/select.js';
import { clean } from '../tasks/text.js';

export interface VodMeta {
  course: string;
  courseId: string;
  // sync_materials 와 같은 규칙의 주차 폴더 이름 (노트가 같은 폴더에서 자료·STT 결과를 함께 읽는다)
  week: string;
  title: string;
  // 강좌 화면에 dimmed 로 표시된 강의 — 열람 기간 지남(링크 없음) / 아직 공개 전(사용 가능 날짜 표시). 영상을 못 받으면 reason 으로 알린다
  unavailable?: { kind: 'expired' | 'notYet'; reason: string };
}

export type VodItem = Omit<VodMeta, 'course' | 'courseId'> & { cmid: number };

const EXPIRED_REASON = '열람 기간이 지나 LMS 가 영상을 주지 않습니다.';

function unavailableOf(li: Element): VodMeta['unavailable'] {
  // 사용 제한(공개 전): 링크는 있지만 "2026년 10월 29일 부터 사용가능" 이 붙는다. 문구는 LMS 데이터라 한 줄로 접고 자른다
  const info = li.querySelector('.availabilityinfo');
  if (info) {
    const when = clean(info.textContent ?? '').slice(0, AVAILABILITY_INFO_MAX_CHARS);
    return { kind: 'notYet', reason: `아직 공개 전입니다 (${when}). 공개된 뒤 STT 변환하세요.` };
  }
  // 열람 기간 지남: 링크 없이 dimmed_text 로만 보인다
  if (li.querySelector('.dimmed, .dimmed_text') && !li.querySelector('.activityinstance a[href]'))
    return { kind: 'expired', reason: EXPIRED_REASON };
}

// 강좌 화면(li#section-N > li.modtype_vod)의 동영상 강의 전부를 직접 읽는다.
// lms-parser fetchVodList 는 링크 없는 dimmed 강의와 기간 표시가 없는 강의를 빠뜨려 쓰지 않는다
export function readVodItems(doc: Document): VodItem[] {
  return Array.from(doc.querySelectorAll('li[id^="section-"]')).flatMap((section) => {
    const n = Number(/^section-(\d+)$/.exec(section.id)?.[1] ?? 0);
    // 이름이 비면 번호를 넣는다 — 파서와 같아 N주차 폴더가 된다
    const week = weekName(n, section.querySelector('.sectionname')?.textContent?.trim() || String(n));
    return Array.from(section.querySelectorAll('li.modtype_vod')).flatMap((li) => {
      const link = li.querySelector('.activityinstance a[href]')?.getAttribute('href');
      const cmid =
        Number(/^module-(\d+)$/.exec(li.id)?.[1] ?? NaN) || (link ? cmidOfUrl(new URL(link, LMS_ORIGIN).href) : null);
      const name = li.querySelector('.instancename')?.cloneNode(true) as Element | undefined;
      if (!cmid || !name) return [];
      for (const hidden of name.querySelectorAll('.accesshide')) hidden.remove();
      const title = clean(name.textContent ?? '');
      if (!title) return [];
      const unavailable = unavailableOf(li);
      return [{ cmid, week, title, ...(unavailable && { unavailable }) }];
    });
  });
}

// 강좌 하나의 화면을 받아 동영상 강의를 읽는다. 세션 만료는 그대로 올리고 그 밖의 실패는 null
export async function courseVods(fetchHtml: FetchHtml, courseId: string): Promise<VodItem[] | null> {
  try {
    return readVodItems(await fetchHtml(getIndexPageLink(courseId)));
  } catch (err) {
    if (err instanceof SessionExpiredError) throw err;
    return null;
  }
}

// 출석 정보와 무관하게 강좌 화면의 VOD 목록에서 cmid 로 찾는다 (과목은 차례로 — 찾으면 멈춘다)
export async function findVod(fetchHtml: FetchHtml, cmid: number): Promise<VodMeta> {
  if (!Number.isSafeInteger(cmid) || cmid <= 0) throw new Error('강의 번호 형식이 올바르지 않습니다.');
  let failures = 0;
  for (const course of await listCourses(fetchHtml)) {
    if (!LMS_NUMERIC_ID.test(course.courseId)) continue;
    const vods = await courseVods(fetchHtml, course.courseId);
    if (!vods) {
      failures++;
      continue;
    }
    const vod = vods.find((v) => v.cmid === cmid);
    if (!vod) continue;
    const { week, title, unavailable } = vod;
    return {
      course: clean(course.courseTitle),
      courseId: course.courseId,
      week,
      title,
      ...(unavailable && { unavailable }),
    };
  }
  throw new Error(
    `추적 중인 강좌(dotbugi-mcp courses)에서 이 동영상 강의를 찾지 못했습니다.${failures > 0 ? ` (과목 ${failures}개의 목록을 읽지 못했습니다)` : ''}`
  );
}
