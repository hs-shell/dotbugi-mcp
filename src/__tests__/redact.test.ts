import { describe, expect, it } from 'vitest';
import { redact } from '../redact.js';

describe('redact', () => {
  it('넘긴 비밀값을 모두 지운다', () => {
    expect(redact('a SECRET b SECRET', ['SECRET'])).toBe('a [REDACTED] b [REDACTED]');
  });

  it('세션 쿠키·연결 코드·sesskey 패턴을 지운다', () => {
    const out = redact(
      'Cookie: MoodleSession=abc123; x https://learn.hansung.ac.kr/my/#dotbugi-connect=1234.code /logout.php?sesskey=K1'
    );
    expect(out).not.toMatch(/abc123|1234\.code|K1/);
    expect(out).toContain('MoodleSession=[REDACTED]');
  });

  it('빈 비밀값은 무시한다', () => {
    expect(redact('text', [''])).toBe('text');
  });
});
