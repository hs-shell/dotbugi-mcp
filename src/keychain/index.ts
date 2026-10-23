import { KEYCHAIN_ACCOUNT, KEYCHAIN_SERVICE } from '../constants.js';
import { isWsl } from '../platform.js';
import { createNativeKeychain } from './native.js';
import type { Keychain } from './types.js';
import { createWslKeychain } from './wsl.js';

export type { Keychain } from './types.js';

// 파일 대체 저장은 두지 않는다 — 키체인을 못 쓰면 로그인을 거부한다
export function getKeychain(): Keychain {
  const create = isWsl() ? createWslKeychain : createNativeKeychain;
  return create(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT);
}
