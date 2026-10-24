import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { CourseBase } from '@dotbugi/lms-parser';
import { safeFileName } from '../assign/download.js';
import { LMS_NUMERIC_ID } from '../constants.js';
import { childDir, ensureRealDir, openCourseDir } from '../materials/sync.js';
import { notesName, readNotesMeta, SUMMARY_MARK } from '../notes/notes-file.js';
import { sha256Of, sourceChanges, type Source } from '../notes/sources.js';
import { clean } from '../tasks/text.js';

// 요약할 주차 범위. 둘 다 없으면 과목 전체
export interface WeekRange {
  from?: number;
  to?: number;
}

export interface SummaryTarget {
  course: string;
  label: string;
  courseDir: string;
  summaryPath: string;
  // new: 요약 없음, stale: 노트·지시사항이 바뀜, no-notes: 범위 안에 노트가 하나도 없음 (노트부터 만들어야 함)
  status: 'new' | 'stale' | 'no-notes';
  reasons: string[];
  sources: Source[];
  missingNotes: string[];
  instructions: string;
}

export interface SummaryScan {
  targets: SummaryTarget[];
  upToDate: number;
  warnings: string[];
}

export const summaryLabel = ({ from, to }: WeekRange) =>
  from === undefined ? '전체' : from === to ? `${from}주차` : `${from}-${to}주차`;
// 범위 단위 파일이라 과목 폴더에 둔다 (주차 폴더 밖이라 노트 지문에 섞이지 않는다)
export const summaryName = (range: WeekRange) => safeFileName(`요약-${summaryLabel(range)}.md`);

// "3주차", "3주차 (중간고사)" 의 3. 범위를 주면 N주차 폴더만 대상
const weekNo = (name: string) => Number(/^(\d+)주차(?!\d)/.exec(name)?.[1] ?? NaN);
const inRange = (name: string, { from, to }: WeekRange) =>
  from === undefined || (weekNo(name) >= from && weekNo(name) <= (to ?? from));

// 과목 폴더의 범위 안 주차들에서 노트 지문(이름은 "<주차>/노트-<주차>.md")과 노트 없는 주차를 모은다
export async function summarySources(root: string, courseDir: string, range: WeekRange) {
  const out = { sources: [] as Source[], missingNotes: [] as string[], warnings: [] as string[] };
  const weeks = (await readdir(courseDir, { withFileTypes: true }).catch(() => []))
    .filter((e) => e.isDirectory() && !e.name.startsWith('.') && inRange(e.name, range))
    .map((e) => e.name)
    .sort((a, b) => a.localeCompare(b, 'ko', { numeric: true }));
  for (const week of weeks) {
    const dir = childDir(courseDir, week);
    try {
      // 주차 폴더가 링크면 저장 위치 밖을 읽게 된다
      await ensureRealDir(root, dir, false);
    } catch (err) {
      out.warnings.push(err instanceof Error ? err.message : String(err));
      continue;
    }
    const notesPath = join(dir, notesName(week));
    const meta = await readNotesMeta(notesPath);
    if (meta === 'other') out.warnings.push(`우리 노트가 아니라 요약에 쓰지 않습니다: ${notesPath}`);
    else if (meta) out.sources.push({ name: `${week}/${notesName(week)}`, sha256: await sha256Of(notesPath) });
    // 자료는 있는데 노트가 없는 주차만 알린다 (빈 폴더는 무시)
    else if ((await readdir(dir, { withFileTypes: true })).some((e) => e.isFile() && !e.name.startsWith('.')))
      out.missingNotes.push(week);
  }
  return out;
}

// 과목마다 범위 요약을 새로 만들거나 다시 만들지 고른다.
// instructions 를 주면 그걸 쓰고(바뀌었으면 다시 만들기 대상), 안 주면 지난 요약의 지시사항을 이어 쓴다
export async function scanSummaryTargets(
  courses: CourseBase[],
  root: string,
  opts: { range?: WeekRange; instructions?: string } = {},
  now = new Date()
): Promise<SummaryScan> {
  const range = opts.range ?? {};
  const out: SummaryScan = { targets: [], upToDate: 0, warnings: [] };
  for (const c of courses) {
    if (!LMS_NUMERIC_ID.test(c.courseId)) continue;
    const title = clean(c.courseTitle);
    try {
      const { dir: courseDir } = await openCourseDir(root, title, c.courseId, now);
      const { sources, missingNotes, warnings } = await summarySources(root, courseDir, range);
      out.warnings.push(...warnings.map((w) => `[${title}] ${w}`));
      if (!sources.length && !missingNotes.length) continue;
      const summaryPath = join(courseDir, summaryName(range));
      const meta = await readNotesMeta(summaryPath, SUMMARY_MARK);
      if (meta === 'other') {
        out.warnings.push(`같은 이름의 다른 파일이 있어 건너뜁니다: ${summaryPath}`);
        continue;
      }
      const instructions = opts.instructions ?? meta?.instructions ?? '';
      const base = { course: title, label: summaryLabel(range), courseDir, summaryPath, sources, missingNotes };
      if (!sources.length) out.targets.push({ ...base, status: 'no-notes', reasons: [], instructions });
      else if (!meta) out.targets.push({ ...base, status: 'new', reasons: [], instructions });
      else {
        const reasons = sourceChanges(meta.sources, sources, () => '노트');
        if (instructions !== meta.instructions) reasons.push('지시사항 변경');
        if (reasons.length) out.targets.push({ ...base, status: 'stale', reasons, instructions });
        else out.upToDate++;
      }
    } catch (err) {
      out.warnings.push(`[${title}] ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return out;
}
