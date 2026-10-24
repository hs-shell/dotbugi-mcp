import { describe, expect, it } from 'vitest';
import { formatBand, HIDE_AFTER_MS, STALE_MS } from '../plugin/hooks/format';

const NOW = Date.parse('2026-10-25T00:10:00.000Z');
const at = (msAgo: number) => new Date(NOW - msAgo).toISOString();
const running = (over: Record<string, unknown> = {}) => ({
  status: 'running',
  phase: 'transcribe',
  progress: 42,
  course: '데이터베이스',
  title: '3주차',
  updatedAt: at(1000),
  ...over,
});
const EMPTY = { pending: [], finished: [] };

describe('formatBand (플러그인 입력창 위 STT 줄)', () => {
  it('진행 중이면 순번·과목·강의·막대를 한 줄로', () => {
    expect(formatBand(running(), { pending: [{}], finished: [{}] }, NOW)).toEqual({
      text: 'STT 2/3 ▸ 데이터베이스 3주차 ▓▓▓░░░░░ 42%',
      tone: 'running',
    });
  });

  it('한 개뿐이면 순번 없이, 변환 전 단계는 이름으로', () => {
    expect(formatBand(running({ phase: 'download', progress: null }), EMPTY, NOW)?.text).toBe(
      'STT ▸ 데이터베이스 3주차 영상 받는 중'
    );
  });

  it('갱신이 끊긴 실행 중·미래 시각·없는 상태는 숨긴다', () => {
    expect(formatBand(running({ updatedAt: at(STALE_MS + 1) }), EMPTY, NOW)).toBeNull();
    expect(formatBand(running({ updatedAt: at(-60_000) }), EMPTY, NOW)).toBeNull();
    expect(formatBand(null, null, NOW)).toBeNull();
    expect(formatBand({ status: 'running' }, EMPTY, NOW)).toBeNull();
  });

  it('끝난 줄은 잠시만 보인다', () => {
    const done = { status: 'done', updatedAt: at(1000) };
    expect(formatBand(done, EMPTY, NOW)).toEqual({ text: '✓ STT 완료', tone: 'done' });
    expect(formatBand({ ...done, updatedAt: at(HIDE_AFTER_MS) }, EMPTY, NOW)).toBeNull();
    expect(formatBand({ status: 'stopped', updatedAt: at(1000) }, EMPTY, NOW)?.text).toBe('○ STT 중지');
  });

  it('여러 개를 끝내면 실패 수를 함께', () => {
    const queue = { pending: [], finished: [{ status: 'done' }, { status: 'error' }] };
    expect(formatBand({ status: 'error', updatedAt: at(1000) }, queue, NOW)?.text).toBe('✓ STT 2개 완료 (실패 1)');
  });

  it('LMS 글의 제어·서식 문자를 지우고 길면 자른다', () => {
    const line = formatBand(
      { status: 'error', updatedAt: at(1000), message: '\u001b[31m빨강\u202e\n줄바꿈' },
      EMPTY,
      NOW
    );
    expect(line).toEqual({ text: '✗ STT 오류: [31m빨강 줄바꿈', tone: 'error' });
    const long = formatBand(running({ course: '가'.repeat(50), title: null }), EMPTY, NOW)?.text;
    expect(long).toBe(`STT ▸ ${'가'.repeat(29)}… ▓▓▓░░░░░ 42%`);
  });
});
