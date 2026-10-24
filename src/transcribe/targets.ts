import { lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { fetchVodList, getIndexPageLink, type FetchHtml } from '@dotbugi/lms-parser';
import { LMS_NUMERIC_ID } from '../constants.js';
import { SessionExpiredError } from '../lms.js';
import { weekName } from '../materials/course-page.js';
import { childDir, openCourseDir } from '../materials/sync.js';
import { listCourses } from '../tasks/collect.js';
import { matchCourses } from '../tasks/courses.js';
import { cmidOfUrl } from '../tasks/select.js';
import { clean } from '../tasks/text.js';
import type { VodMeta } from './find-vod.js';
import { transcriptFileName } from './pipeline.js';

export type VodTarget = VodMeta & { cmid: number };

// 결과 파일이 이미 있는지 — 폴더를 만들거나 옮기지 않고 보기만 한다 (실제 건너뛰기는 작업 프로세스가 다시 확인)
async function hasTranscript(root: string, t: VodTarget, now: Date): Promise<boolean> {
  try {
    const { dir } = await openCourseDir(root, t.course, t.courseId, now);
    return !!(await lstat(join(childDir(dir, t.week), transcriptFileName(t.title))).catch(() => null));
  } catch {
    // 같은 이름의 다른 과목 폴더 등 — 대상에 남기고 작업 프로세스가 판단하게 한다
    return false;
  }
}

// 추적 강좌(course 가 있으면 그중 맞는 강좌)의 동영상 강의 중 아직 결과 파일이 없는 것
export async function listVodTargets(
  fetchHtml: FetchHtml,
  root: string,
  course?: string,
  now = new Date()
): Promise<{ targets: VodTarget[]; failures: number }> {
  let courses = await listCourses(fetchHtml);
  if (course !== undefined) {
    courses = matchCourses(courses, course);
    if (!courses.length) throw new Error(`추적 중인 강좌에서 "${clean(course)}" 과목을 찾지 못했습니다.`);
  }
  const targets: VodTarget[] = [];
  let failures = 0;
  for (const c of courses) {
    if (!LMS_NUMERIC_ID.test(c.courseId)) continue;
    let vods;
    try {
      vods = await fetchVodList(fetchHtml, getIndexPageLink(c.courseId));
    } catch (err) {
      // 파서가 원래 오류를 cause 로 감싼다 (find-vod 와 같다)
      const cause = (err as Error).cause;
      if (cause instanceof SessionExpiredError) throw cause;
      failures++;
      continue;
    }
    for (const v of vods) {
      const cmid = cmidOfUrl(v.url);
      if (cmid === null || targets.some((t) => t.cmid === cmid)) continue;
      const t = {
        cmid,
        course: clean(c.courseTitle),
        courseId: c.courseId,
        week: weekName(v.week, v.subject),
        title: clean(v.title),
      };
      if (!(await hasTranscript(root, t, now))) targets.push(t);
    }
  }
  return { targets, failures };
}
