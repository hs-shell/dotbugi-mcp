import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionExpiredError } from '../lms.js';
import { collectTasks, toTaskItems } from '../tasks/collect.js';
import { fakeLmsFetch, LOGIN_REDIRECT, PAGES } from './fixtures/lms-pages.js';

// 추적 설정(~/.config)은 import 시점 homedir 로 정해진다 — 개발자 실제 설정을 읽지 않게 빈 테스트 홈을 쓴다
const state = vi.hoisted(() => ({ home: `${process.env.TMPDIR ?? '/tmp'}/dotbugi-collect-home-${process.pid}` }));
vi.mock('node:os', async (orig) => ({ ...(await orig<typeof import('node:os')>()), homedir: () => state.home }));

const SESSION = 'abcdefghij0123456789';
const L = 'https://learn.hansung.ac.kr';
const fetchMock = vi.fn<typeof fetch>(fakeLmsFetch);
vi.stubGlobal('fetch', fetchMock);
beforeEach(() => fetchMock.mockImplementation(fakeLmsFetch));
afterEach(() => fetchMock.mockReset());

// 특정 페이지만 바꿔 끼운 fetch 대역
const withPages = (overrides: Record<string, string | Response>) =>
  fetchMock.mockImplementation(async (url) => {
    const page = overrides[String(url)];
    if (page instanceof Response) return page;
    return page === undefined ? fakeLmsFetch(url) : new Response(`<html><body>${page}</body></html>`);
  });
const fetchedUrls = () => fetchMock.mock.calls.map(([url]) => String(url));

describe('collectTasks', () => {
  it('비교과를 빼고 모든 항목을 모은다 (기간·마감 필터는 조회 시점에)', async () => {
    const { items, failures } = await collectTasks(SESSION);
    expect(failures).toBe(0);
    expect(items).toEqual([
      {
        type: 'vod',
        course: '자료구조',
        title: '트리 순회',
        done: false,
        status: '미출석 (진도 25%)',
        start: '2026-10-20T00:00:00+09:00',
        deadline: '2026-10-27T23:59:59+09:00',
        url: `${L}/mod/vod/view.php?id=1`,
        vod: { courseId: '100', week: 8 },
      },
      expect.objectContaining({ type: 'vod', title: '다음 주 강의', start: '2026-10-28T00:00:00+09:00' }),
      expect.objectContaining({ type: 'assign', title: '과제1', done: false, deadline: '2026-10-25T18:00:00+09:00' }),
      expect.objectContaining({ type: 'assign', title: '과제2', done: true, status: '제출' }),
      expect.objectContaining({ type: 'assign', title: '지난 과제', start: null }),
      expect.objectContaining({ type: 'quiz', title: '퀴즈1', done: false, status: '미응시' }),
      expect.objectContaining({ type: 'assign', course: '운영체제', title: '기한 없는 과제', deadline: null }),
    ]);
    expect(fetchedUrls().some((u) => u.includes('id=300'))).toBe(false);
  });

  it('추적 설정을 따른다 — 꺼진 강좌는 요청하지 않고, 켠 비교과는 가져온다', async () => {
    const { items } = await collectTasks(SESSION, undefined, { version: 1, courses: { '100': false, '300': true } });
    expect(new Set(items.map((i) => i.course))).not.toContain('자료구조');
    const urls = fetchedUrls();
    expect(urls.some((u) => u.includes('id=100'))).toBe(false);
    expect(urls.some((u) => u.includes('id=300'))).toBe(true);
    expect(urls.some((u) => u.includes('id=200'))).toBe(true);
  });

  it('LMS 요청은 출처 고정 경로로 세션 쿠키와 함께, 동시에 3개까지만', async () => {
    let active = 0;
    let peak = 0;
    fetchMock.mockImplementation(async (url) => {
      peak = Math.max(peak, ++active);
      await new Promise((r) => setTimeout(r, 5));
      active--;
      return fakeLmsFetch(url);
    });
    await collectTasks(SESSION);
    expect(peak).toBe(3);
    for (const [url, init] of fetchMock.mock.calls) {
      expect(new URL(String(url)).origin).toBe(L);
      expect(init).toMatchObject({ redirect: 'manual', headers: { cookie: `MoodleSession=${SESSION}` } });
    }
  });

  it('동시에 두 번 모아도 프로세스 전체 동시 요청은 3개를 넘지 않는다', async () => {
    let active = 0;
    let peak = 0;
    fetchMock.mockImplementation(async (url) => {
      peak = Math.max(peak, ++active);
      await new Promise((r) => setTimeout(r, 5));
      active--;
      return fakeLmsFetch(url);
    });
    await Promise.all([collectTasks(SESSION), collectTasks(SESSION)]);
    expect(peak).toBe(3);
  });

  it('과목 목록 단계에서 로그인으로 리다이렉트되면 세션 만료', async () => {
    fetchMock.mockImplementation(async () => LOGIN_REDIRECT());
    await expect(collectTasks(SESSION)).rejects.toBeInstanceOf(SessionExpiredError);
  });

  it('과목 스크래핑 중 만료돼도 (파서가 삼킨 실패라도) 세션 만료로 알린다', async () => {
    withPages({ [`${L}/mod/quiz/view.php?id=9`]: LOGIN_REDIRECT() });
    await expect(collectTasks(SESSION)).rejects.toBeInstanceOf(SessionExpiredError);
  });

  it('내 강좌 목록이 없는 페이지면 빈 목록 대신 오류', async () => {
    withPages({ [`${L}/`]: '<div>다른 페이지</div>' });
    await expect(collectTasks(SESSION)).rejects.toThrow('내 강좌 목록을 찾지 못했습니다');
  });

  it('로그인 이외로 리다이렉트되면 이동 주소를 밝히지 않는 오류', async () => {
    withPages({ [`${L}/`]: new Response(null, { status: 303, headers: { location: `${L}/my/?sesskey=K1` } }) });
    const err = (await collectTasks(SESSION).catch((e: unknown) => e)) as Error;
    expect(err.message).toContain('HTTP 303');
    expect(err.message).not.toContain('K1');
  });

  it('일부 요청이 실패하면 나머지는 돌려주고 실패 수를 센다 (퀴즈 상세 실패 포함)', async () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    withPages({
      [`${L}/mod/assign/index.php?id=200`]: new Response('', { status: 500 }),
      [`${L}/mod/quiz/view.php?id=9`]: new Response('', { status: 500 }),
    });
    const { items, failures } = await collectTasks(SESSION);
    expect(failures).toBe(2);
    expect(items.some((t) => t.title === '과제1')).toBe(true);
    expect(stderr.mock.calls.join('')).toContain('2건');
    expect(stderr.mock.calls.join('')).not.toContain(SESSION);
    stderr.mockRestore();
  });

  it('같은 과목·같은 항목은 한 번만 (확장과 같은 키)', async () => {
    const course100 = /<li class="">[\s\S]*?id=100[\s\S]*?<\/li>/.exec(PAGES[`${L}/`])![0];
    const assignRow = `<tr><td class="cell c0"></td><td class="cell c1"><a href="/mod/assign/view.php?id=5">과제1</a></td>
      <td class="cell c2">2026-10-25 18:00</td><td class="cell c3">미제출</td></tr>`;
    withPages({
      [`${L}/`]: PAGES[`${L}/`].replace('</ul>', `${course100}</ul>`),
      [`${L}/mod/assign/index.php?id=100`]: `<table class="generaltable"><tbody>${assignRow}${assignRow}</tbody></table>`,
    });
    const { items } = await collectTasks(SESSION);
    expect(items.filter((t) => t.title === '과제1')).toHaveLength(1);
    expect(fetchedUrls().filter((u) => u === `${L}/mod/assign/index.php?id=100`)).toHaveLength(1);
  });

  it('cachedQuizzes 에 있는 마감된 퀴즈는 상세 페이지를 다시 요청하지 않는다', async () => {
    withPages({
      [`${L}/mod/quiz/index.php?id=100`]: `<table class="generaltable"><tbody>
        <tr><td class="cell c0">1주차</td><td class="cell c1"><a href="view.php?id=10">지난 퀴즈</a></td>
        <td class="cell c2">2026-10-01 09:00</td></tr></tbody></table>`,
    });
    const quizUrl = `${L}/mod/quiz/view.php?id=10`;
    const { items } = await collectTasks(SESSION, [{ url: quizUrl, isSubmit: true }]);
    expect(fetchedUrls()).not.toContain(quizUrl);
    expect(items).toContainEqual(expect.objectContaining({ title: '지난 퀴즈', done: true, status: '응시' }));
  });

  it('LMS 텍스트의 서식 문자를 지우고, LMS 출처가 아닌 링크는 비운다', async () => {
    withPages({
      [`${L}/mod/assign/index.php?id=200`]: `<table class="generaltable"><tbody>
        <tr><td class="cell c0"></td><td class="cell c1"><a href="https://evil.example/x">과제\u202e 이름\u200b</a></td>
        <td class="cell c2">곧\u200b마감</td><td class="cell c3">미제출</td></tr></tbody></table>`,
    });
    const { items } = await collectTasks(SESSION);
    expect(items).toContainEqual(
      expect.objectContaining({ course: '운영체제', title: '과제 이름', deadline: '곧 마감', url: '' })
    );
  });

  it('VOD 시간 형식을 못 읽으면 진도 NaN% 대신 진도를 뺀다', () => {
    const vod = { week: 1, subject: '1', title: '강의', url: `${L}/mod/vod/view.php?id=1`, range: '', length: '' };
    const att = { title: '강의', week: 1, isAttendance: 'X', weeklyAttendance: 'X' };
    const status = (requiredTime: string, watchedTime: string) =>
      toTaskItems(
        { courseId: '1', courseTitle: '과목', prof: '' },
        {
          vodDataArray: [vod],
          vodAttendanceArray: [{ ...att, requiredTime, watchedTime }],
          assignDataArray: [],
          quizDataArray: [],
        }
      )[0].status;
    expect(status('알수없음', '05:00')).toBe('미출석');
    expect(status('00:00', '05:00')).toBe('미출석');
    expect(status('20:00', '05:00')).toBe('미출석 (진도 25%)');
  });
});
