import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { DOMParser } from 'linkedom';
import type { FetchHtml } from '@dotbugi/lms-parser';
import { TRANSCRIBE_QUEUE_MAX } from '../constants.js';
import type { Asker } from '../tools/confirm.js';
import { resolveTargets } from '../tools/transcribe-vod.js';
import { listVodTargets, type VodTarget } from '../transcribe/targets.js';
import { PAGES } from './fixtures/lms-pages.js';

// 추적 강좌 설정 경로는 import 시점에 homedir 로 정해진다 — 테스트 전용 홈 (설정 파일 없음 = 기본 추적)
const state = vi.hoisted(() => ({ home: `${process.env.TMPDIR ?? '/tmp'}/dotbugi-targets-home-${process.pid}` }));
vi.mock('node:os', async (orig) => ({ ...(await orig<typeof import('node:os')>()), homedir: () => state.home }));

const fetchHtml = (async (url: string) => {
  const html = PAGES[new URL(url, 'https://learn.hansung.ac.kr').href] ?? '';
  return new DOMParser().parseFromString(`<html><body>${html}</body></html>`, 'text/html') as unknown as Document;
}) as FetchHtml;

const roots: string[] = [];
afterAll(() => Promise.all([state.home, ...roots].map((d) => rm(d, { recursive: true, force: true }))));

describe('listVodTargets', () => {
  it('추적 강좌의 동영상 강의를 모으고, 결과 파일이 이미 있는 강의는 뺀다', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dotbugi-targets-'));
    roots.push(root);
    const now = new Date('2026-10-24T12:00:00+09:00');
    const { targets: all, failures } = await listVodTargets(fetchHtml, root, undefined, now);
    expect(failures).toBe(0);
    expect(all.find((t) => t.cmid === 2)).toEqual({
      cmid: 2,
      course: '자료구조',
      courseId: '100',
      week: '8주차',
      title: '다음 주 강의',
    });
    // 같은 과목 폴더에 녹취가 있으면 빠진다
    const weekDir = join(root, '2026-2학기', '자료구조', '8주차');
    await mkdir(weekDir, { recursive: true });
    await writeFile(join(weekDir, '녹취-다음 주 강의.md'), 'x');
    const { targets } = await listVodTargets(fetchHtml, root, undefined, now);
    expect(targets.map((t) => t.cmid)).not.toContain(2);
    expect(targets).toHaveLength(all.length - 1);
  });

  it('course 로 고르고, 없는 과목이면 오류', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dotbugi-targets-'));
    roots.push(root);
    const { targets } = await listVodTargets(fetchHtml, root, '자료');
    expect(targets.length).toBeGreaterThan(0);
    expect(targets.every((t) => t.course === '자료구조')).toBe(true);
    await expect(listVodTargets(fetchHtml, root, '없는과목')).rejects.toThrow('찾지 못했습니다');
  });
});

describe('resolveTargets', () => {
  const vod = (cmid: number): VodTarget => ({
    cmid,
    course: '자료구조',
    courseId: '100',
    week: '1주차',
    title: `강의 ${cmid}`,
  });
  const asker = (answer?: boolean): Asker & { elicit: ReturnType<typeof vi.fn> } => ({
    caps: answer === undefined ? {} : { elicitation: { form: {} } },
    elicit: vi.fn(async () => ({ action: 'accept' as const, content: { confirm: answer! } })),
  });
  const list = (n: number) =>
    vi.fn(async () => ({ targets: Array.from({ length: n }, (_, i) => vod(i + 1)), failures: 0 }));

  it('cmids 는 목록을 읽지 않고 그대로', async () => {
    const l = list(3);
    expect(await resolveTargets({ cmids: [7, 8] }, asker(), l)).toEqual({ cmids: [7, 8], notes: [] });
    expect(l).not.toHaveBeenCalled();
  });

  it('course·전체는 확인 창에서 승인해야 시작하고, 거절하면 아무것도 넣지 않는다', async () => {
    const yes = asker(true);
    expect(await resolveTargets({ course: '자료' }, yes, list(2))).toEqual({ cmids: [1, 2], notes: [] });
    expect(yes.elicit.mock.calls[0][0].message).toContain('자료구조 · 1주차 · 강의 1');
    expect(await resolveTargets({}, asker(false), list(2))).toMatchObject({
      text: expect.stringContaining('시작하지 않았습니다'),
    });
  });

  it('all 은 확인 없이 바로, 상한을 넘으면 앞에서 자르고 알린다', async () => {
    const a = asker(true);
    const r = await resolveTargets({ all: true }, a, list(TRANSCRIBE_QUEUE_MAX + 3));
    expect(a.elicit).not.toHaveBeenCalled();
    expect(r).toMatchObject({ cmids: Array.from({ length: TRANSCRIBE_QUEUE_MAX }, (_, i) => i + 1) });
    expect('notes' in r && r.notes[0]).toContain(`${TRANSCRIBE_QUEUE_MAX + 3}개`);
  });

  it('확인 창이 없으면 토큰을 돌려주고, 같은 대상으로 토큰을 넣어야 시작한다', async () => {
    const first = await resolveTargets({}, asker(), list(2));
    const token = 'text' in first ? /confirmToken: "([0-9a-f]+)"/.exec(first.text)?.[1] : undefined;
    expect(token).toBeDefined();
    expect(await resolveTargets({ confirmToken: token }, asker(), list(2))).toEqual({ cmids: [1, 2], notes: [] });
  });

  it('대상이 없으면 시작하지 않는다', async () => {
    expect(await resolveTargets({}, asker(true), list(0))).toMatchObject({ text: expect.stringContaining('없습니다') });
  });
});
