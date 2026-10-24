import { afterEach, describe, expect, it, vi } from 'vitest';
import { LMS_REQUEST_TIMEOUT_MS } from '../constants.js';
import { createFetchHtml } from '../lms-html.js';
import { lmsFetch, lmsLogout, SessionExpiredError, verifySession } from '../lms.js';

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
});

describe('createFetchHtml', () => {
  it('200 으로 온 로그인 화면(비밀번호 입력란)은 세션 만료로, login 도구를 안내한다', async () => {
    fetchMock.mockResolvedValue(new Response('<form><input type="password" name="password"></form>'));
    const err = (await createFetchHtml(SESSION)('/').catch((e: unknown) => e)) as Error;
    expect(err).toBeInstanceOf(SessionExpiredError);
    expect(err.message).toContain('login 도구');
  });

  it('보통 페이지는 그대로 파싱한다', async () => {
    fetchMock.mockResolvedValue(new Response('<ul class="my-course-lists"></ul>'));
    const doc = await createFetchHtml(SESSION)('/');
    expect(doc.querySelector('.my-course-lists')).not.toBeNull();
  });
});
