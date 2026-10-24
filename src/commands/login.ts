import { log } from '../log.js';
import { loginWithBrowser } from '../login/browser.js';
import { loginWithExtension } from '../login/extension.js';
import { assertKeychain, verifyAndSave } from '../login/save.js';
import type { LoginMethod } from '../session.js';

export async function login(method: LoginMethod): Promise<void> {
  await assertKeychain();
  const session = method === 'browser' ? await loginWithBrowser() : await loginWithExtension();
  await verifyAndSave(session, method);
  log('로그인 완료. 세션을 OS 키체인에 저장했습니다.');
}
