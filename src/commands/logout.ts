import { lmsLogout } from '../lms.js';
import { log } from '../log.js';
import { deleteSession, InvalidStoredSessionError, readSession, type StoredSession } from '../session.js';

// CLI 는 stderr 로, logout 도구는 응답 본문으로 안내를 모은다 (안내에는 세션 값이 들어가지 않는다)
export async function logout(report: (message: string) => void = log): Promise<void> {
  let stored: StoredSession | null;
  try {
    stored = await readSession();
  } catch (err) {
    if (!(err instanceof InvalidStoredSessionError)) throw err;
    // 형식이 깨진 값은 서버 로그아웃 없이 지우기만 한다 (그래야 다시 login 할 수 있다)
    await deleteSession();
    return report('형식이 올바르지 않은 세션을 OS 키체인에서 삭제했습니다.');
  }
  if (!stored) return report('저장된 세션이 없습니다.');
  if (stored.method === 'browser') {
    // 임시 프로필 로그인은 dotbugi-mcp 전용 세션이므로 서버에서도 끊는다
    const ended = await lmsLogout(stored.session).catch(() => false);
    report(ended ? 'LMS 서버 세션을 종료했습니다.' : 'LMS 서버 세션은 이미 만료되었거나 종료하지 못했습니다.');
  } else {
    report('확장 연결 세션은 평소 브라우저와 공유되므로 LMS 서버 로그아웃은 하지 않습니다.');
  }
  await deleteSession();
  report('OS 키체인에서 세션을 삭제했습니다.');
}
