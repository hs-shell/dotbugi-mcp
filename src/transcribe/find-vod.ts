import { fetchVodList, getIndexPageLink, type FetchHtml } from '@dotbugi/lms-parser';
import { LMS_NUMERIC_ID } from '../constants.js';
import { SessionExpiredError } from '../lms.js';
import { weekName } from '../materials/course-page.js';
import { listCourses } from '../tasks/collect.js';
import { cmidOfUrl } from '../tasks/select.js';
import { clean } from '../tasks/text.js';

export interface VodMeta {
  course: string;
  courseId: string;
  // sync_materials 와 같은 규칙의 주차 폴더 이름 (summarize_week 가 같은 폴더에서 자료·녹취를 함께 읽는다)
  week: string;
  title: string;
  // 열람 기간이 지나 강좌 화면에 링크 없이(dimmed) 표시된 강의 — 영상을 못 받으면 그 이유를 알려 준다
  dimmed?: boolean;
}

// 파서 목록에서 빠진 VOD(열람 기간이 지나 링크가 없는 dimmed 등): li#module-<cmid>.modtype_vod 를 직접 읽는다
function findDimmed(doc: Document, cmid: number): { week: string; title: string; dimmed: boolean } | undefined {
  const li = doc.querySelector(`li#module-${cmid}.modtype_vod`);
  const name = li?.querySelector('.instancename')?.cloneNode(true) as Element | undefined;
  if (!li || !name) return;
  name.querySelector('.accesshide')?.remove();
  const title = clean(name.textContent ?? '');
  if (!title) return;
  const section = li.closest('li[id^="section-"]');
  return {
    week: weekName(
      Number(/^section-(\d+)$/.exec(section?.id ?? '')?.[1] ?? 0),
      section?.querySelector('.sectionname')?.textContent ?? ''
    ),
    title,
    // 파서는 기간 표시가 없는 일반 VOD 도 빠뜨린다 — 실제 dimmed 표시가 있을 때만 "기간 지남" 으로 안내
    dimmed: !!li.querySelector('.dimmed, .dimmed_text'),
  };
}

// 출석 정보와 무관하게 강좌 화면의 VOD 목록에서 cmid 로 찾는다 (과목은 차례로 — 찾으면 멈춘다)
export async function findVod(fetchHtml: FetchHtml, cmid: number): Promise<VodMeta> {
  // 셀렉터에 넣으므로 숫자만 받는다
  if (!Number.isSafeInteger(cmid) || cmid <= 0) throw new Error('강의 번호 형식이 올바르지 않습니다.');
  let failures = 0;
  for (const course of await listCourses(fetchHtml)) {
    if (!LMS_NUMERIC_ID.test(course.courseId)) continue;
    let vods;
    // 파서가 받은 강좌 화면을 붙잡아 dimmed 확인에 다시 쓴다 — 요청을 늘리지 않는다
    let page: Document | undefined;
    try {
      vods = await fetchVodList(async (url) => (page = await fetchHtml(url)), getIndexPageLink(course.courseId));
    } catch (err) {
      // 파서가 원래 오류를 cause 로 감싼다
      const cause = (err as Error).cause;
      if (cause instanceof SessionExpiredError) throw cause;
      failures++;
      continue;
    }
    const vod = vods.find((v) => cmidOfUrl(v.url) === cmid);
    if (!vod) {
      const dimmed = page && findDimmed(page, cmid);
      if (dimmed) return { course: clean(course.courseTitle), courseId: course.courseId, ...dimmed };
      continue;
    }
    return {
      course: clean(course.courseTitle),
      courseId: course.courseId,
      // shortcut: 파서는 섹션 이름이 비면 번호를 넣어 N주차가 된다 (sync_materials 는 section-N) — 빈 이름이 실제로 보이면 강좌 화면에서 직접 읽기
      week: weekName(vod.week, vod.subject),
      title: clean(vod.title),
    };
  }
  throw new Error(
    `추적 중인 강좌(dotbugi-mcp courses)에서 이 강의(VOD)를 찾지 못했습니다.${failures > 0 ? ` (과목 ${failures}개의 목록을 읽지 못했습니다)` : ''}`
  );
}
