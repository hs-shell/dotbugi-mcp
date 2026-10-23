import type { FetchHtml } from '@dotbugi/lms-parser';
import { DOMParser } from 'linkedom';
import { LMS_MAX_CONCURRENT_REQUESTS } from './constants.js';
import { createLimiter } from './limit.js';
import { lmsFetch } from './lms.js';

// 프로세스 전체에서 하나 — 새로고침이 겹쳐도 LMS 동시 요청 수가 상한을 넘지 않는다
const limit = createLimiter(LMS_MAX_CONCURRENT_REQUESTS);

const isRedirect = (status: number) => status >= 300 && status < 400;

// @dotbugi/lms-parser 에 주입할 Node 용 FetchHtml. 세션 쿠키는 lmsFetch 로만 붙인다 (출처 고정·리다이렉트 차단)
export function createFetchHtml(session: string): FetchHtml {
  return (url) =>
    limit(async () => {
      const res = await lmsFetch(url, session);
      // 로그인 이외로의 리다이렉트는 따라가지 않는다 (이동할 주소는 알리지 않는다)
      if (isRedirect(res.status))
        throw new Error(`LMS 가 요청한 페이지 대신 다른 곳으로 이동시켰습니다 (HTTP ${res.status}).`);
      if (!res.ok) throw new Error(`LMS 응답 오류 HTTP ${res.status}`);
      return new DOMParser().parseFromString(await res.text(), 'text/html') as unknown as Document;
    });
}
