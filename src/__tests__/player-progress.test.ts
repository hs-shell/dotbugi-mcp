import { afterEach, describe, expect, it, vi } from 'vitest';
import { SessionExpiredError } from '../lms.js';
import { createProgressFetcher, progressOf } from '../player/progress.js';
import { fakeLmsFetch, LOGIN_REDIRECT } from './fixtures/lms-pages.js';

const SESSION = 'abcdefghij0123456789';
const fetchMock = vi.fn<typeof fetch>(fakeLmsFetch);
vi.stubGlobal('fetch', fetchMock);
afterEach(() => fetchMock.mockImplementation(fakeLmsFetch));

describe('createProgressFetcher', () => {
  it('과목 진도 페이지 한 장만 세션 쿠키와 함께 가져와 제목(정리된)·주차로 진도를 찾는다', async () => {
    const rows = await createProgressFetcher(SESSION)('100');
    expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual([
      'https://learn.hansung.ac.kr/report/ubcompletion/user_progress.php?id=100',
    ]);
    expect(progressOf(rows, { title: '트리 순회', week: 8 })).toEqual({
      done: false,
      progress: 25,
      remainingSeconds: 900,
    });
  });

  it('로그인으로 리다이렉트되면 세션 만료 오류를 그대로 올린다', async () => {
    fetchMock.mockImplementation(async () => LOGIN_REDIRECT());
    await expect(createProgressFetcher(SESSION)('100')).rejects.toBeInstanceOf(SessionExpiredError);
  });
});

describe('progressOf', () => {
  const row = { title: 'A', week: 1, weeklyAttendance: 'x' };
  it('서버 출석 판정을 따르고, 시간 형식을 모르면 진도는 null', () => {
    expect(progressOf([{ ...row, isAttendance: 'o', requiredTime: '10:00', watchedTime: '12:00' }], row)).toEqual({
      done: true,
      progress: 100,
      remainingSeconds: 0,
    });
    expect(progressOf([{ ...row, isAttendance: 'x', requiredTime: '', watchedTime: '01:00' }], row)).toEqual({
      done: false,
      progress: null,
      remainingSeconds: null,
    });
    expect(progressOf([{ ...row, week: 2, isAttendance: 'o' }], row).done).toBe(false);
  });
});
