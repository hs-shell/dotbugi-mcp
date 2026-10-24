import { lstat } from 'node:fs/promises';
import { join } from 'node:path';
import type { FetchHtml } from '@dotbugi/lms-parser';
import { LMS_NUMERIC_ID } from '../constants.js';
import { childDir, openCourseDir } from '../materials/sync.js';
import { listCourses } from '../tasks/collect.js';
import { matchCourses } from '../tasks/courses.js';
import { clean } from '../tasks/text.js';
import { courseVods, type VodMeta } from './find-vod.js';
import { transcriptFileNames } from './pipeline.js';

export type VodTarget = VodMeta & { cmid: number };

// 결과 파일이 이미 있는지 — 폴더를 만들거나 옮기지 않고 보기만 한다 (실제 건너뛰기는 작업 프로세스가 다시 확인)
async function hasTranscript(root: string, t: VodTarget, now: Date): Promise<boolean> {
  try {
    const { dir } = await openCourseDir(root, t.course, t.courseId, now);
    const week = childDir(dir, t.week);
    for (const name of transcriptFileNames(t.title)) if (await lstat(join(week, name)).catch(() => null)) return true;
    return false;
  } catch {
    // 같은 이름의 다른 과목 폴더 등 — 대상에 남기고 작업 프로세스가 판단하게 한다
    return false;
  }
}

// 추적 강좌(course 가 있으면 그중 맞는 강좌)의 동영상 강의 중 아직 결과 파일이 없는 것.
// 열람 기간이 지났거나 공개 전인 강의는 unavailable 로 따로 돌려준다 (영상을 받지 못하니 기본 대상에서 뺀다)
export async function listVodTargets(
  fetchHtml: FetchHtml,
  root: string,
  course?: string,
  now = new Date()
): Promise<{ targets: VodTarget[]; unavailable: VodTarget[]; failures: number }> {
  let courses = await listCourses(fetchHtml);
  if (course !== undefined) {
    courses = matchCourses(courses, course);
    if (!courses.length) throw new Error(`추적 중인 강좌에서 "${clean(course)}" 과목을 찾지 못했습니다.`);
  }
  const targets: VodTarget[] = [];
  const unavailable: VodTarget[] = [];
  let failures = 0;
  for (const c of courses) {
    if (!LMS_NUMERIC_ID.test(c.courseId)) continue;
    const vods = await courseVods(fetchHtml, c.courseId);
    if (!vods) {
      failures++;
      continue;
    }
    for (const v of vods) {
      if ([...targets, ...unavailable].some((t) => t.cmid === v.cmid)) continue;
      const t = { ...v, course: clean(c.courseTitle), courseId: c.courseId };
      if (await hasTranscript(root, t, now)) continue;
      (t.unavailable ? unavailable : targets).push(t);
    }
  }
  return { targets, unavailable, failures };
}
