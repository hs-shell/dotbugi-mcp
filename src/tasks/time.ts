import { LMS_UTC_OFFSET } from '../constants.js';

const MS_PER_MINUTE = 60_000;
const MS_PER_HOUR = 60 * MS_PER_MINUTE;
const MS_PER_DAY = 24 * MS_PER_HOUR;
// normalizeLmsDate 결과 형식: "2024-03-10 23:59" 또는 "2024-03-10 23:59:59"
const LMS_DATE = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2})(:\d{2})?$/;

// LMS 날짜(한국 시간)를 오프셋이 붙은 ISO 문자열로. 형식을 모르면 원문을 그대로 둔다
export function toIsoDeadline(lmsDate: string | null): string | null {
  if (!lmsDate) return null;
  const m = LMS_DATE.exec(lmsDate.trim());
  return m ? `${m[1]}T${m[2]}${m[3] ?? ':00'}${LMS_UTC_OFFSET}` : lmsDate;
}

// VOD 출석 인정 기간 "시작 ~ 종료" 분리
export function splitRange(range: string | null): [string | null, string | null] {
  const [start, end] = (range ?? '').split(' ~ ');
  return [start || null, end || null];
}

// 원문 문자열 마감이면 NaN
export function deadlineMs(deadline: string | null): number {
  return deadline ? Date.parse(deadline) : NaN;
}

// dotbugi src/lib/dateUtils.ts calculateRemainingTime 을 한국어 고정·짧은 형식으로 옮김
export function formatRemaining(deadline: string | null, now: number): string {
  const ms = deadlineMs(deadline);
  if (Number.isNaN(ms)) return '정보 없음';
  const diff = ms - now;
  if (diff <= 0) return '마감';
  const days = Math.floor(diff / MS_PER_DAY);
  const hours = Math.floor((diff % MS_PER_DAY) / MS_PER_HOUR);
  const minutes = Math.floor((diff % MS_PER_HOUR) / MS_PER_MINUTE);
  if (days > 0) return `${days}일 ${hours}시간`;
  if (hours > 0) return `${hours}시간 ${minutes}분`;
  return `${minutes}분`;
}
