import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionExpiredError } from '../lms.js';
import { collectTasks } from '../tasks/collect.js';
import { fakeLmsFetch, LOGIN_REDIRECT, NOW } from './fixtures/lms-pages.js';

const SESSION = 'abcdefghij0123456789';
const fetchMock = vi.fn<typeof fetch>(fakeLmsFetch);
vi.stubGlobal('fetch', fetchMock);
beforeEach(() => fetchMock.mockImplementation(fakeLmsFetch));
afterEach(() => fetchMock.mockReset());

describe('collectTasks', () => {
  it('비교과를 빼고 진행 중·마감 전 항목만 모은다', async () => {
    const items = await collectTasks(SESSION, NOW.getTime());
    expect(items).toEqual([
      {
        type: 'vod',
        course: '자료구조',
        title: '트리 순회',
        done: false,
        status: '미출석 (진도 25%)',
        deadline: '2026-10-27T23:59:59+09:00',
        url: 'https://learn.hansung.ac.kr/mod/vod/view.php?id=1',
      },
      expect.objectContaining({ type: 'assign', title: '과제1', done: false, deadline: '2026-10-25T18:00:00+09:00' }),
      expect.objectContaining({ type: 'assign', title: '과제2', done: true, status: '제출' }),
      expect.objectContaining({ type: 'quiz', title: '퀴즈1', done: false, status: '미응시' }),
      expect.objectContaining({ type: 'assign', course: '운영체제', title: '기한 없는 과제', deadline: null }),
    ]);
    const urls = fetchMock.mock.calls.map(([url]) => String(url));
    expect(urls.some((u) => u.includes('id=300'))).toBe(false);
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
    await collectTasks(SESSION, NOW.getTime());
    expect(peak).toBe(3);
    for (const [url, init] of fetchMock.mock.calls) {
      expect(new URL(String(url)).origin).toBe('https://learn.hansung.ac.kr');
      expect(init).toMatchObject({ redirect: 'manual', headers: { cookie: `MoodleSession=${SESSION}` } });
    }
  });

  it('과목 목록 단계에서 로그인으로 리다이렉트되면 세션 만료', async () => {
    fetchMock.mockImplementation(async () => LOGIN_REDIRECT());
    await expect(collectTasks(SESSION)).rejects.toBeInstanceOf(SessionExpiredError);
  });

  it('과목 스크래핑 중 만료돼도 (파서가 삼킨 실패라도) 세션 만료로 알린다', async () => {
    fetchMock.mockImplementation(async (url) =>
      String(url).includes('mod/quiz/view.php') ? LOGIN_REDIRECT() : fakeLmsFetch(url)
    );
    await expect(collectTasks(SESSION, NOW.getTime())).rejects.toBeInstanceOf(SessionExpiredError);
  });
});
