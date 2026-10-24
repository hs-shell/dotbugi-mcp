import { afterEach, describe, expect, it, vi } from 'vitest';
import { LMS_REQUEST_TIMEOUT_MS } from '../constants.js';
import { createFetchHtml } from '../lms-html.js';
import { isLoginPage, lmsFetch, lmsLogout, SessionExpiredError, verifySession } from '../lms.js';
import { LOGIN_PAGE } from './fixtures/lms-pages.js';

const SESSION = 'abcdefghij0123456789';
const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);
afterEach(() => fetchMock.mockReset());

describe('lmsFetch', () => {
  it.each([
    'https://evil.example/my/',
    'http://learn.hansung.ac.kr/my/',
    '//evil.example/x',
    'https://learn.hansung.ac.kr.evil.example/',
    'https://learn.hansung.ac.kr@evil.example/',
    'https://user:pw@learn.hansung.ac.kr/',
    'https://learn.hansung.ac.kr:8443/',
  ])('LMS 출처가 아니면 요청하지 않는다: %s', async (url) => {
    await expect(lmsFetch(url, SESSION)).rejects.toThrow('LMS 이외');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('LMS 경로에만 세션 쿠키를 붙이고 리다이렉트를 따라가지 않는다', async () => {
    fetchMock.mockResolvedValue(new Response('ok'));
    await lmsFetch('/my/', SESSION);
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe('https://learn.hansung.ac.kr/my/');
    expect(init).toMatchObject({ redirect: 'manual', headers: { cookie: `MoodleSession=${SESSION}` } });
  });

  it('로그인 페이지로의 리다이렉트는 세션 만료', async () => {
    fetchMock.mockResolvedValue(
      new Response(null, { status: 303, headers: { location: 'https://learn.hansung.ac.kr/login/index.php' } })
    );
    await expect(lmsFetch('/my/', SESSION)).rejects.toBeInstanceOf(SessionExpiredError);
    await expect(verifySession(SESSION)).resolves.toBe(false);
  });

  it('응답이 없으면 정해진 시간에 끊고, 오류에 세션을 담지 않는다', async () => {
    const timeout = vi
      .spyOn(AbortSignal, 'timeout')
      .mockReturnValue(AbortSignal.abort(new DOMException('The operation was aborted due to timeout', 'TimeoutError')));
    fetchMock.mockImplementation((_url: URL, init: RequestInit) => Promise.reject(init.signal!.reason));
    const err = (await lmsFetch('/my/', SESSION).catch((e: unknown) => e)) as Error;
    expect(timeout).toHaveBeenCalledWith(LMS_REQUEST_TIMEOUT_MS);
    expect(err.message).toBe('LMS 가 20초 안에 응답하지 않았습니다.');
    expect(err.message).not.toContain(SESSION);
    timeout.mockRestore();
  });

  it('200 이면 유효한 세션', async () => {
    fetchMock.mockResolvedValue(new Response('ok'));
    await expect(verifySession(SESSION)).resolves.toBe(true);
  });

  it('200 이어도 로그인 화면이면 만료 — 다른 도구(createFetchHtml)와 같은 판정', async () => {
    fetchMock.mockResolvedValue(new Response(LOGIN_PAGE));
    await expect(verifySession(SESSION)).resolves.toBe(false);
  });
});

describe('isLoginPage', () => {
  it('로그인 폼(id=login 또는 login/index.php 로 보내는 폼)의 비밀번호 입력란만 로그인 화면으로 본다', () => {
    expect(isLoginPage(LOGIN_PAGE)).toBe(true);
    expect(isLoginPage('<form action="/login/index.php"><input type="password"></form>')).toBe(true);
    // 교수가 쓴 본문·자료 HTML 의 비밀번호 입력란은 만료가 아니다
    expect(isLoginPage('<div id="intro"><input type="password"></div>')).toBe(false);
    expect(isLoginPage('<form action="/mod/quiz/attempt.php"><input type="password"></form>')).toBe(false);
  });
});

describe('lmsLogout', () => {
  const home = () => new Response('<script>M.cfg = {"sesskey":"abc123XYZ"};</script>');
  const toLogin = () =>
    new Response(null, { status: 303, headers: { location: 'https://learn.hansung.ac.kr/login/index.php' } });

  it('로그아웃 뒤 세션이 끊겼으면 true', async () => {
    fetchMock.mockResolvedValueOnce(home()).mockResolvedValueOnce(toLogin()).mockResolvedValueOnce(toLogin());
    await expect(lmsLogout(SESSION)).resolves.toBe(true);
    expect(String(fetchMock.mock.calls[1][0])).toBe('https://learn.hansung.ac.kr/login/logout.php?sesskey=abc123XYZ');
  });

  it('확인 페이지만 오고 세션이 살아 있으면 false', async () => {
    fetchMock
      .mockResolvedValueOnce(home())
      .mockResolvedValueOnce(new Response('confirm'))
      .mockResolvedValueOnce(new Response('ok'));
    await expect(lmsLogout(SESSION)).resolves.toBe(false);
  });

  it('200 로그인 화면이면 이미 만료 — 로그인 화면의 sesskey 로 로그아웃을 보내지 않는다', async () => {
    fetchMock.mockResolvedValue(new Response(LOGIN_PAGE));
    await expect(lmsLogout(SESSION)).resolves.toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('createFetchHtml', () => {
  it('200 으로 온 로그인 화면(비밀번호 입력란)은 세션 만료로, login 도구를 안내한다', async () => {
    fetchMock.mockResolvedValue(new Response(LOGIN_PAGE));
    const err = (await createFetchHtml(SESSION)('/').catch((e: unknown) => e)) as Error;
    expect(err).toBeInstanceOf(SessionExpiredError);
    expect(err.message).toContain('login 도구');
  });

  it('교수가 쓴 본문에 비밀번호 입력란이 있어도 만료로 보지 않는다', async () => {
    fetchMock.mockResolvedValue(new Response('<div id="intro"><p>예시</p><input type="password"></div>'));
    await expect(createFetchHtml(SESSION)('/')).resolves.toBeDefined();
  });

  it('보통 페이지는 그대로 파싱한다', async () => {
    fetchMock.mockResolvedValue(new Response('<ul class="my-course-lists"></ul>'));
    const doc = await createFetchHtml(SESSION)('/');
    expect(doc.querySelector('.my-course-lists')).not.toBeNull();
  });
});
