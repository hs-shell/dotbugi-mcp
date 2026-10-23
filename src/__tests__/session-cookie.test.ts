import { describe, expect, it } from 'vitest';
import { pickSessionCookie } from '../login/session-cookie.js';

const SESSION = 'abcdefghij0123456789xyz';

describe('pickSessionCookie', () => {
  it('LMS 호스트의 MoodleSession 만 고른다', () => {
    expect(pickSessionCookie([{ name: 'MoodleSession', value: SESSION, domain: 'learn.hansung.ac.kr' }])).toBe(SESSION);
    expect(pickSessionCookie([{ name: 'MoodleSession', value: SESSION, domain: '.learn.hansung.ac.kr' }])).toBe(
      SESSION
    );
  });

  it.each([
    { name: 'MoodleSession', value: SESSION, domain: 'evil.example' },
    { name: 'MoodleSession', value: SESSION, domain: 'hansung.ac.kr' },
    { name: 'MoodleSession', value: SESSION, domain: 'learn.hansung.ac.kr.evil.example' },
    { name: 'MoodleSessionTest', value: SESSION, domain: 'learn.hansung.ac.kr' },
    { name: 'MoodleSession', value: 'bad;value', domain: 'learn.hansung.ac.kr' },
  ])('그 외는 무시: %o', (cookie) => {
    expect(pickSessionCookie([cookie])).toBeUndefined();
  });
});
