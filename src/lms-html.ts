import type { FetchHtml } from '@dotbugi/lms-parser';
import { DOMParser } from 'linkedom';
import { LMS_MAX_CONCURRENT_REQUESTS } from './constants.js';
import { createLimiter } from './limit.js';
import { lmsFetch } from './lms.js';

// @dotbugi/lms-parser 에 주입할 Node 용 FetchHtml. 세션 쿠키는 lmsFetch 로만 붙인다 (출처 고정·리다이렉트 차단)
export function createFetchHtml(session: string): FetchHtml {
  const limit = createLimiter(LMS_MAX_CONCURRENT_REQUESTS);
  return (url) =>
    limit(async () => {
      const res = await lmsFetch(url, session);
      if (!res.ok) throw new Error(`LMS 응답 오류 HTTP ${res.status}`);
      return new DOMParser().parseFromString(await res.text(), 'text/html') as unknown as Document;
    });
}
