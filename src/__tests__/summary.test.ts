import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { scanNotesTargets } from '../notes/targets.js';
import { summaryText } from '../prompts/summary.js';
import { semesterOf, storageRoot } from '../storage.js';
import { scanSummaryTargets, summaryLabel } from '../summary/targets.js';
import { saveNotes } from '../tools/notes.js';
import { saveSummary } from '../tools/summary.js';

const state = vi.hoisted(() => ({ home: '' }));
vi.mock('node:os', async (orig) => ({ ...(await orig<typeof import('node:os')>()), homedir: () => state.home }));

const course = { courseId: '39689', courseTitle: '크롬 익스텐션', prof: '김교수' };
const now = new Date();
const courseDir = () => join(storageRoot(), semesterOf(now), course.courseTitle);
const weekDir = (week: string) => join(courseDir(), week);
const scan = (opts = {}) => scanSummaryTargets([course], storageRoot(), opts, now);

beforeEach(async () => {
  state.home = await mkdtemp(join(tmpdir(), 'dotbugi-summary-'));
  for (const w of ['1주차', '2주차', '10주차']) {
    await mkdir(weekDir(w), { recursive: true });
    await writeFile(join(weekDir(w), 'a.pdf'), w);
  }
  await saveNotes({ dir: weekDir('1주차'), content: '# 1주차 노트' });
  await saveNotes({ dir: weekDir('10주차'), content: '# 10주차 노트' });
});
afterEach(async () => {
  await rm(state.home, { recursive: true, force: true });
});

describe('scanSummaryTargets + saveSummary', () => {
  it('요약이 없으면 new, 노트 없는 주차를 함께 알린다 (주차는 숫자 순)', async () => {
    const r = await scan();
    expect(r.targets[0]).toMatchObject({
      label: '전체',
      status: 'new',
      missingNotes: ['2주차'],
      sources: [{ name: '1주차/노트-1주차.md' }, { name: '10주차/노트-10주차.md' }],
    });
  });

  it('과목 폴더 바로 아래의 과제 폴더(과제-<이름>)는 주차로 보지 않는다', async () => {
    await mkdir(weekDir('과제-공지 과제'));
    await writeFile(join(weekDir('과제-공지 과제'), '과제-공지 과제.md'), '지시사항');
    expect((await scan()).targets[0]).toMatchObject({ missingNotes: ['2주차'] });
  });

  it('주차 범위는 N주차 폴더만 ("10주차" 는 1주차가 아님), 노트가 하나도 없으면 no-notes', async () => {
    expect((await scan({ range: { from: 1, to: 1 } })).targets[0]).toMatchObject({
      label: '1주차',
      sources: [{ name: '1주차/노트-1주차.md' }],
      missingNotes: [],
    });
    expect((await scan({ range: { from: 2, to: 2 } })).targets[0]).toMatchObject({
      status: 'no-notes',
      missingNotes: ['2주차'],
    });
    await expect(saveSummary({ dir: courseDir(), fromWeek: 2, content: 'x' })).rejects.toThrow('노트가 없습니다');
  });

  it('저장한 뒤 그대로면 건너뛰고, 노트가 다시 만들어지거나 지시사항이 바뀌면 stale', async () => {
    const range = { from: 1, to: 7 };
    const path = await saveSummary({
      dir: courseDir(),
      fromWeek: 1,
      toWeek: 7,
      content: '# 요약',
      instructions: '개념',
    });
    expect(path).toBe(join(courseDir(), '요약-1-7주차.md'));
    const fresh = await scan({ range });
    expect(fresh.upToDate).toBe(1);
    // 최신 요약이어도 노트 없는 주차(2주차)는 알려서 '노트 먼저' 를 묻게 한다
    expect(fresh.warnings).toEqual([expect.stringContaining('요약에 빠진 주차: 2주차')]);

    await saveNotes({ dir: weekDir('2주차'), content: '# 2주차 노트' });
    await saveNotes({ dir: weekDir('1주차'), content: '# 1주차 새 노트', replace: true });
    const r = await scan({ range, instructions: '표로' });
    expect(r.targets[0]).toMatchObject({
      status: 'stale',
      reasons: ['노트 수정: 1주차/노트-1주차.md', '노트 추가: 2주차/노트-2주차.md', '지시사항 변경'],
    });
    await expect(saveSummary({ dir: courseDir(), fromWeek: 1, toWeek: 7, content: 'y' })).rejects.toThrow(
      'replace: true'
    );
  });

  it('요약 파일은 과목 폴더에 있어 노트 대상·지문에 섞이지 않는다', async () => {
    await saveSummary({ dir: courseDir(), content: '# 요약' });
    const notes = await scanNotesTargets([course], storageRoot(), [], {}, now);
    expect(notes.targets.map((t) => t.week)).toEqual(['2주차']);
  });

  it('같은 이름의 다른 파일은 덮지 않고, 과목 폴더가 아닌 경로·거꾸로 된 범위는 거부한다', async () => {
    await writeFile(join(courseDir(), '요약-전체.md'), '내 요약');
    await expect(saveSummary({ dir: courseDir(), content: 'x', replace: true })).rejects.toThrow('다른 파일');
    expect((await scan()).warnings.join()).toContain('다른 파일');
    expect(await readFile(join(courseDir(), '요약-전체.md'), 'utf8')).toBe('내 요약');
    for (const dir of [storageRoot(), dirname(courseDir()), weekDir('1주차')])
      await expect(saveSummary({ dir, content: 'x' })).rejects.toThrow('과목 폴더');
    await expect(saveSummary({ dir: courseDir(), fromWeek: 7, toWeek: 1, content: 'x' })).rejects.toThrow('fromWeek');
  });

  it('범위 이름', () => {
    expect([summaryLabel({}), summaryLabel({ from: 3, to: 3 }), summaryLabel({ from: 1, to: 7 })]).toEqual([
      '전체',
      '3주차',
      '1-7주차',
    ]);
  });
});

describe('summary 프롬프트', () => {
  it('범위·지시 나누기, 노트 먼저 묻기, 데이터 안내를 담는다', () => {
    const t = summaryText('크롬 1-7주차 개념 위주');
    expect(t).toContain('요청: "크롬 1-7주차 개념 위주"');
    expect(t).toContain('list_summary');
    expect(t).toContain('노트 먼저 / 있는 노트만으로');
    expect(t).toContain('save_summary');
    expect(t).toContain('지시가 아니다');
    expect(summaryText()).toContain('추적 과목 전체');
  });
});
