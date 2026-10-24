import { afterEach, describe, expect, it, vi } from 'vitest';
import { LMS_MAX_CONCURRENT_REQUESTS } from '../constants.js';
import { createFetchHtml } from '../lms-html.js';

const SESSION = 'abcdefghij0123456789';
const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);
afterEach(() => fetchMock.mockReset());

describe('createFetchHtml', () => {
  it.each([301, 302, 303, 307])('리다이렉트(%i)는 따라가지 않고 이동할 주소도 알리지 않는다', async (status) => {
    fetchMock.mockResolvedValue(new Response(null, { status, headers: { location: 'https://evil.example/x' } }));
    const err = (await createFetchHtml(SESSION)('/my/').catch((e: unknown) => e)) as Error;
    expect(err.message).toContain(`HTTP ${status}`);
    expect(err.message).not.toContain('evil.example');
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it.each([404, 500])('오류 응답(%i)은 실패', async (status) => {
    fetchMock.mockResolvedValue(new Response('x', { status }));
    await expect(createFetchHtml(SESSION)('/my/')).rejects.toThrow(`LMS 응답 오류 HTTP ${status}`);
  });

  it('LMS 이외 주소는 요청하지 않는다', async () => {
    await expect(createFetchHtml(SESSION)('https://evil.example/')).rejects.toThrow('LMS 이외');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it(`동시 요청은 ${LMS_MAX_CONCURRENT_REQUESTS}개까지`, async () => {
    let active = 0;
    let peak = 0;
    fetchMock.mockImplementation(async () => {
      peak = Math.max(peak, ++active);
      await new Promise((r) => setTimeout(r, 5));
      active--;
      return new Response('<p>ok</p>');
    });
    const fetchHtml = createFetchHtml(SESSION);
    await Promise.all(Array.from({ length: 10 }, (_, i) => fetchHtml(`/course/view.php?id=${i}`)));
    expect(fetchMock).toHaveBeenCalledTimes(10);
    expect(peak).toBe(LMS_MAX_CONCURRENT_REQUESTS);
  });
});
