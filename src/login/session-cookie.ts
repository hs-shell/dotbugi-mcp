import { LMS_HOST, SESSION_COOKIE, SESSION_PATTERN } from '../constants.js';

export interface CdpCookie {
  name: string;
  value: string;
  domain: string;
}

// 브라우저 전체 쿠키 중 LMS 호스트의 MoodleSession 만 고른다 (하위·유사 도메인은 제외)
export function pickSessionCookie(cookies: readonly CdpCookie[]): string | undefined {
  const value = cookies.find(
    (c) => c.name === SESSION_COOKIE && (c.domain === LMS_HOST || c.domain === `.${LMS_HOST}`)
  )?.value;
  return value && SESSION_PATTERN.test(value) ? value : undefined;
}
