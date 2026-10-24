import { getKeychain } from '../keychain/index.js';
import { verifySession } from '../lms.js';
import { saveSession, type LoginMethod } from '../session.js';

// CLI login 과 login 도구 공용
// 키체인을 못 쓰면 로그인 전에 거부한다 (파일 대체 저장 없음)
export async function assertKeychain(): Promise<void> {
  try {
    await getKeychain().get();
  } catch {
    throw new Error(
      'OS 키체인을 사용할 수 없어 로그인하지 않습니다. (Linux: GNOME Keyring 등 Secret Service 실행 여부를 확인하세요)'
    );
  }
}

export async function verifyAndSave(session: string, method: LoginMethod): Promise<void> {
  if (!(await verifySession(session))) throw new Error('받은 세션으로 LMS에 접속하지 못해 저장하지 않았습니다.');
  await saveSession(session, method);
}
