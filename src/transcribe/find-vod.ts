import { fetchVodList, getIndexPageLink, type FetchHtml } from '@dotbugi/lms-parser';
import { LMS_NUMERIC_ID } from '../constants.js';
import { SessionExpiredError } from '../lms.js';
import { weekName } from '../materials/course-page.js';
import { cmidOf } from '../player/scheduler.js';
import { listCourses } from '../tasks/collect.js';
import { clean } from '../tasks/text.js';

export interface VodMeta {
  course: string;
  courseId: string;
  // sync_materials 와 같은 규칙의 주차 폴더 이름 (summarize_week 가 같은 폴더에서 자료·녹취를 함께 읽는다)
  week: string;
  title: string;
}

// 출석 정보와 무관하게 강좌 화면의 VOD 목록에서 cmid 로 찾는다 (과목은 차례로 — 찾으면 멈춘다)
export async function findVod(fetchHtml: FetchHtml, cmid: number): Promise<VodMeta> {
  let failures = 0;
  for (const course of await listCourses(fetchHtml)) {
    if (!LMS_NUMERIC_ID.test(course.courseId)) continue;
    let vods;
    try {
      vods = await fetchVodList(fetchHtml, getIndexPageLink(course.courseId));
    } catch (err) {
      // 파서가 원래 오류를 cause 로 감싼다
      const cause = (err as Error).cause;
      if (cause instanceof SessionExpiredError) throw cause;
      failures++;
      continue;
    }
    const vod = vods.find((v) => cmidOf(v.url) === String(cmid));
    if (!vod) continue;
    // 파서는 섹션 이름이 없으면 섹션 번호를 넣는다 — weekName 이 section-N 으로 정하게 비운다
    const section = vod.subject === String(vod.week) ? '' : vod.subject;
    return {
      course: clean(course.courseTitle),
      courseId: course.courseId,
      week: weekName(vod.week, section),
      title: clean(vod.title),
    };
  }
  throw new Error(
    `수강 과목에서 이 강의(VOD)를 찾지 못했습니다.${failures > 0 ? ` (과목 ${failures}개의 목록을 읽지 못했습니다)` : ''}`
  );
}
