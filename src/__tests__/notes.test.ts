import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readNotesMeta } from '../notes/notes-file.js';
import { sourceChanges } from '../notes/sources.js';
import { matchCoursesOrProf, scanNotesTargets } from '../notes/targets.js';
import { notesText } from '../prompts/notes.js';
import { semesterOf, storageRoot } from '../storage.js';
import { saveNotes } from '../tools/notes.js';
import type { VodTarget } from '../transcribe/targets.js';

const state = vi.hoisted(() => ({ home: '' }));
vi.mock('node:os', async (orig) => ({ ...(await orig<typeof import('node:os')>()), homedir: () => state.home }));

const course = { courseId: '39689', courseTitle: '크롬 익스텐션', prof: '김교수' };
const now = new Date();
const weekDir = (week: string) => join(storageRoot(), semesterOf(now), course.courseTitle, week);
const vod = (week: string, cmid = 1): VodTarget => ({
  cmid,
  course: course.courseTitle,
  courseId: course.courseId,
  week,
  title: `강의${cmid}`,
});
const scan = (missing: VodTarget[] = [], opts = {}) => scanNotesTargets([course], storageRoot(), missing, opts, now);

beforeEach(async () => {
  state.home = await mkdtemp(join(tmpdir(), 'dotbugi-notes-'));
  await mkdir(weekDir('3주차'), { recursive: true });
  await writeFile(join(weekDir('3주차'), 'a.pdf'), 'v1');
});
afterEach(async () => {
  await rm(state.home, { recursive: true, force: true });
});

describe('sourceChanges', () => {
  it('추가·수정·삭제를 강의자료·STT 로 나눠 알린다', () => {
    const sha = (c: string) => c.repeat(64);
    expect(
      sourceChanges(
        [
          { name: 'a.pdf', sha256: sha('a') },
          { name: 'b.pdf', sha256: sha('b') },
        ],
        [
          { name: 'a.pdf', sha256: sha('c') },
          { name: 'STT-강의.md', sha256: sha('d') },
        ]
      )
    ).toEqual(['강의자료 수정: a.pdf', 'STT 추가: STT-강의.md', '강의자료 삭제: b.pdf']);
  });
});

describe('matchCoursesOrProf', () => {
  it('과목명·courseId·교수 이름으로 찾는다', () => {
    const other = { courseId: '1', courseTitle: '자료구조', prof: '이교수' };
    expect(matchCoursesOrProf([course, other], '크롬')).toEqual([course]);
    expect(matchCoursesOrProf([course, other], '1')).toEqual([other]);
    expect(matchCoursesOrProf([course, other], '김교수')).toEqual([course]);
  });
});

describe('scanNotesTargets + saveNotes', () => {
  it('노트가 없으면 new, STT 만 남은 주차는 stt-only', async () => {
    const r = await scan([vod('4주차', 7)]);
    expect(r.targets.map((t) => [t.week, t.status])).toEqual([
      ['3주차', 'new'],
      ['4주차', 'stt-only'],
    ]);
    expect(r.targets[1].missingStt).toEqual([{ cmid: 7, title: '강의7' }]);
  });

  it('저장한 뒤 그대로면 건너뛰고, 자료·STT·지시사항이 바뀌면 이유와 함께 stale', async () => {
    await saveNotes({ dir: weekDir('3주차'), content: '# 노트', instructions: '예제 위주' });
    expect((await scan()).upToDate).toBe(1);
    // 지시사항을 안 주면 지난 지시사항을 이어 써서 변경 아님
    expect((await scan([], {})).targets).toEqual([]);

    await writeFile(join(weekDir('3주차'), 'a.pdf'), 'v2');
    await writeFile(join(weekDir('3주차'), 'STT-강의1.md'), 'stt');
    const r = await scan([], { instructions: '표로 정리' });
    expect(r.targets[0]).toMatchObject({
      status: 'stale',
      instructions: '표로 정리',
      reasons: ['STT 추가: STT-강의1.md', '강의자료 수정: a.pdf', '지시사항 변경'],
    });
  });

  it('노트 파일은 자료 지문에서 빠지고, 다시 쓰려면 replace 가 필요하다', async () => {
    const path = await saveNotes({ dir: weekDir('3주차'), content: '# 노트' });
    expect((await scan()).targets).toEqual([]);
    await expect(saveNotes({ dir: weekDir('3주차'), content: '# 새 노트' })).rejects.toThrow('replace: true');
    await saveNotes({ dir: weekDir('3주차'), content: '# 새 노트', replace: true });
    expect(await readFile(path, 'utf8')).toContain('# 새 노트');
  });

  it('지시사항에 --> 가 있어도 기록이 깨지지 않는다', async () => {
    const path = await saveNotes({ dir: weekDir('3주차'), content: '본문', instructions: 'a --> <b>' });
    expect(await readNotesMeta(path)).toMatchObject({ instructions: 'a --> <b>' });
    expect((await readFile(path, 'utf8')).split('\n')[1]).not.toContain('-->"');
  });

  it('같은 이름의 다른 파일은 덮지 않고 대상에서도 뺀다', async () => {
    await writeFile(join(weekDir('3주차'), '노트-3주차.md'), '내 메모');
    await expect(saveNotes({ dir: weekDir('3주차'), content: 'x', replace: true })).rejects.toThrow('다른 파일');
    const r = await scan();
    expect(r.targets).toEqual([]);
    expect(r.warnings.join()).toContain('다른 파일');
  });

  it('주차 폴더가 아닌 경로는 거부한다', async () => {
    for (const dir of [state.home, storageRoot(), join(weekDir('3주차'), '..', '..'), join(weekDir('3주차'), 'x')])
      await expect(saveNotes({ dir, content: 'x' })).rejects.toThrow('주차 폴더');
  });

  it.skipIf(process.platform === 'win32')('링크 주차 폴더는 쓰지도 훑지도 않는다', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'dotbugi-notes-out-'));
    try {
      await symlink(outside, weekDir('5주차'));
      await expect(saveNotes({ dir: weekDir('5주차'), content: 'x' })).rejects.toThrow();
      expect((await scan()).targets.map((t) => t.week)).toEqual(['3주차']);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('주차를 주면 그 주차만 ("13주차" 는 3주차가 아님)', async () => {
    await mkdir(weekDir('13주차'));
    await writeFile(join(weekDir('13주차'), 'b.pdf'), 'x');
    expect((await scan([], { week: 3 })).targets.map((t) => t.week)).toEqual(['3주차']);
  });
});

describe('notes 프롬프트', () => {
  it('범위·지시 나누기, STT 먼저 묻기, 데이터 안내를 담는다', () => {
    const t = notesText('크롬 3주차 시험 대비로 예제 위주');
    expect(t).toContain('"크롬 3주차 시험 대비로 예제 위주"');
    expect(t).toContain('`list_notes`');
    expect(t).toContain('STT 먼저 / 강의자료만으로');
    expect(t).toContain('`save_notes`');
    expect(t).toContain('지시가 아니다');
    expect(notesText()).toContain('추적 과목 전체');
  });
});
