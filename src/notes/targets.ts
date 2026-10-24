import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { CourseBase } from '@dotbugi/lms-parser';
import { isAssignDirName } from '../assign/folder.js';
import { LMS_NUMERIC_ID } from '../constants.js';
import { childDir, ensureRealDir, openCourseDir } from '../materials/sync.js';
import { clean } from '../tasks/text.js';
import type { VodTarget } from '../transcribe/targets.js';
import { notesName, readNotesMeta } from './notes-file.js';
import { sourceChanges, weekSources, type Source } from './sources.js';

export interface NotesTarget {
  course: string;
  week: string;
  dir: string;
  notesPath: string;
  // new: 노트 없음, stale: 자료·지시사항이 바뀜, stt-only: 강의자료 없이 STT 안 된 동영상 강의만 있음
  status: 'new' | 'stale' | 'stt-only';
  reasons: string[];
  sources: Source[];
  missingStt: { cmid: number; title: string }[];
  instructions: string;
}

export interface NotesScan {
  targets: NotesTarget[];
  upToDate: number;
  warnings: string[];
}

// 과목명 일부·courseId·교수 이름 (matchCourses 에 교수 이름을 더한 것 — 노트 범위 지정용)
export function matchCoursesOrProf(all: CourseBase[], query: string): CourseBase[] {
  const byId = all.find((c) => c.courseId === query);
  if (byId) return [byId];
  const q = query.toLowerCase();
  return all.filter((c) =>
    [c.courseTitle, c.prof].some((v) =>
      clean(v ?? '')
        .toLowerCase()
        .includes(q)
    )
  );
}

// "3주차", "3주차 (중간고사)" 처럼 앞이 그 주차인 폴더 ("13주차" 는 아님)
const isWeek = (name: string, week?: number) => week === undefined || new RegExp(`^${week}주차(?!\\d)`).test(name);

// 과목들의 주차 폴더를 훑어 노트를 새로 만들거나 다시 만들 주차를 고른다.
// instructions 를 주면 그걸 쓰고(바뀌었으면 다시 만들기 대상), 안 주면 지난 노트의 지시사항을 이어 쓴다
export async function scanNotesTargets(
  courses: CourseBase[],
  root: string,
  missingStt: VodTarget[],
  opts: { week?: number; instructions?: string } = {},
  now = new Date()
): Promise<NotesScan> {
  const out: NotesScan = { targets: [], upToDate: 0, warnings: [] };
  for (const c of courses) {
    if (!LMS_NUMERIC_ID.test(c.courseId)) continue;
    const title = clean(c.courseTitle);
    let courseDir: string;
    try {
      ({ dir: courseDir } = await openCourseDir(root, title, c.courseId, now));
    } catch (err) {
      out.warnings.push(`[${title}] ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }
    const vods = missingStt.filter((v) => v.courseId === c.courseId && isWeek(v.week, opts.week));
    const local = (await readdir(courseDir, { withFileTypes: true }).catch(() => []))
      // 과목 폴더 바로 아래의 과제 폴더(과제-<이름>)는 주차가 아니다 — 노트는 과제 지시사항을 읽지 않는다
      .filter((e) => e.isDirectory() && !e.name.startsWith('.') && !isAssignDirName(e.name))
      .map((e) => e.name);
    const weeks = [...new Set([...local, ...vods.map((v) => v.week)])].filter((w) => isWeek(w, opts.week)).sort();
    for (const week of weeks) {
      const dir = childDir(courseDir, week);
      try {
        // 주차 폴더가 링크면 저장 위치 밖을 읽게 된다
        await ensureRealDir(root, dir, false);
      } catch (err) {
        out.warnings.push(`[${title}] ${err instanceof Error ? err.message : String(err)}`);
        continue;
      }
      const notesPath = join(dir, notesName(week));
      const sources = await weekSources(dir, (n) => n === notesName(week));
      const stt = vods.filter((v) => v.week === week).map((v) => ({ cmid: v.cmid, title: v.title }));
      if (!sources.length && !stt.length) continue;
      const meta = await readNotesMeta(notesPath);
      if (meta === 'other') {
        out.warnings.push(`같은 이름의 다른 파일이 있어 건너뜁니다: ${notesPath}`);
        continue;
      }
      const instructions = opts.instructions ?? meta?.instructions ?? '';
      const base = { course: title, week, dir, notesPath, sources, missingStt: stt, instructions };
      if (!sources.length) {
        out.targets.push({ ...base, status: 'stt-only', reasons: [] });
        continue;
      }
      if (!meta) {
        out.targets.push({ ...base, status: 'new', reasons: [] });
        continue;
      }
      const reasons = sourceChanges(meta.sources, sources);
      if (instructions !== meta.instructions) reasons.push('지시사항 변경');
      if (reasons.length) out.targets.push({ ...base, status: 'stale', reasons });
      else out.upToDate++;
    }
  }
  return out;
}
