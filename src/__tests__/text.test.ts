import { describe, expect, it } from 'vitest';
import { clean } from '../tasks/text.js';

describe('clean', () => {
  it('줄바꿈·제어문자·서식 문자(제로폭·방향 전환)를 공백 하나로 접는다', () => {
    expect(clean(' 과제\n\t1\u0007​‮끝 ')).toBe('과제 1 끝');
  });
});
