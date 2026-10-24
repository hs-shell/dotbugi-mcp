import { describe, expect, it } from 'vitest';
import { formatRemaining, toIsoDeadline } from '../tasks/time.js';

const now = Date.parse('2026-10-24T12:00:00+09:00');

describe('toIsoDeadline', () => {
  it('LMS 날짜를 한국 시간 ISO 로', () => {
    expect(toIsoDeadline('2026-10-25 18:00')).toBe('2026-10-25T18:00:00+09:00');
    expect(toIsoDeadline('2026-10-27 23:59:59')).toBe('2026-10-27T23:59:59+09:00');
  });
  it('모르는 형식은 원문, 없으면 null', () => {
    expect(toIsoDeadline('곧 마감')).toBe('곧 마감');
    expect(toIsoDeadline(null)).toBeNull();
  });
});

describe('formatRemaining', () => {
  it.each([
    ['2026-10-26T15:30:00+09:00', '2일 3시간'],
    ['2026-10-24T15:20:00+09:00', '3시간 20분'],
    ['2026-10-24T12:05:00+09:00', '5분'],
    ['2026-10-24T11:00:00+09:00', '지남'],
    ['곧 마감', '정보 없음'],
    [null, '정보 없음'],
  ])('%s → %s', (deadline, expected) => {
    expect(formatRemaining(deadline, now)).toBe(expected);
  });
});
