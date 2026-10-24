import { describe, expect, it, vi } from 'vitest';
import { appCommand } from '../player/open-app.js';

vi.mock('../login/find-browser.js', () => ({ findBrowser: () => '/usr/bin/google-chrome' }));

describe('appCommand', () => {
  it('브라우저에는 숫자 cmid 로 만든 LMS 플레이어 --app 인자 하나만 넘긴다', () => {
    expect(appCommand('42')).toEqual([
      '/usr/bin/google-chrome',
      ['--app=https://learn.hansung.ac.kr/mod/vod/viewer.php?id=42'],
    ]);
  });

  it.each(['', '1&x=1', '1 --flag', '../1', '12345678901'])('숫자가 아닌 cmid 는 거부: %j', (cmid) => {
    expect(() => appCommand(cmid)).toThrow('강의 번호 형식');
  });
});
