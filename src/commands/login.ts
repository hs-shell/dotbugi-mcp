import { log } from '../log.js';
import { loginWithBrowser, WSL_UNSUPPORTED } from '../login/browser.js';
import { loginWithExtension } from '../login/extension.js';
import { assertKeychain, verifyAndSave } from '../login/save.js';
import { isWsl } from '../platform.js';
import type { LoginMethod } from '../session.js';

export async function login(method: LoginMethod): Promise<void> {
  if (method === 'browser' && isWsl())
    throw new Error(`${WSL_UNSUPPORTED} dotbugi 확장 방식(dotbugi-mcp login)을 쓰거나 Windows 터미널에서 실행하세요.`);
  await assertKeychain();
  const session = method === 'browser' ? await loginWithBrowser() : await loginWithExtension();
  await verifyAndSave(session, method);
  log('로그인 완료. 세션을 OS 키체인에 저장했습니다.');
}
