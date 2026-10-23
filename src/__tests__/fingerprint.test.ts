import { describe, expect, it } from 'vitest';
import { codeFingerprint } from '../login/fingerprint.js';

describe('codeFingerprint', () => {
  it('앞 6자를 대문자 XXX-XXX 로 만든다', () => {
    expect(codeFingerprint('aB3dEfGhIjKl')).toBe('AB3-DEF');
    expect(codeFingerprint('a-_bcd_rest')).toBe('A-_-BCD');
  });
});
