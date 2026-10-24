import { spawn } from 'node:child_process';
import { LMS_NUMERIC_ID, LMS_ORIGIN, VOD_VIEWER_PATH } from '../constants.js';
import { findBrowser } from '../login/find-browser.js';

// 브라우저 실행 인자에는 숫자 cmid 로 만든 LMS 주소만 들어간다 (LMS 가 준 문자열은 넘기지 않는다)
export function appCommand(cmid: string): [string, string[]] {
  if (!LMS_NUMERIC_ID.test(cmid)) throw new Error('강의 번호 형식이 올바르지 않습니다.');
  const browser = findBrowser();
  if (!browser) throw new Error('Chrome·Edge·Brave·Whale 중 설치된 브라우저를 찾지 못했습니다.');
  return [browser, [`--app=${LMS_ORIGIN}${VOD_VIEWER_PATH}?id=${cmid}`]];
}

// 평소 프로필의 앱 모드 창으로 공식 플레이어를 연다. 셸을 거치지 않고, 이미 실행 중인 브라우저면 그 창에 붙는다
export function openApp(cmid: string): Promise<void> {
  const [cmd, args] = appCommand(cmid);
  return new Promise((resolve, reject) => {
    // detached: 터미널 Ctrl+C(프로세스 그룹 SIGINT)가 새로 띄운 브라우저까지 끄지 않게
    const child = spawn(cmd, args, { stdio: 'ignore', detached: true });
    child.once('error', () => reject(new Error('브라우저를 열지 못했습니다.')));
    child.once('spawn', () => {
      child.unref();
      resolve();
    });
  });
}
