import { lmsLogout } from '../lms.js';
import { log } from '../log.js';
import { deleteSession, readSession } from '../session.js';

export async function logout(): Promise<void> {
  const stored = await readSession();
  if (!stored) return log('저장된 세션이 없습니다.');
  if (stored.method === 'browser') {
    // 임시 프로필 로그인은 dotbugi-mcp 전용 세션이므로 서버에서도 끊는다
    const ended = await lmsLogout(stored.session).catch(() => false);
    log(ended ? 'LMS 서버 세션을 종료했습니다.' : 'LMS 서버 세션은 이미 만료되었거나 종료하지 못했습니다.');
  } else {
    log('확장 연결 세션은 평소 브라우저와 공유되므로 LMS 서버 로그아웃은 하지 않습니다.');
  }
  await deleteSession();
  log('OS 키체인에서 세션을 삭제했습니다.');
}
