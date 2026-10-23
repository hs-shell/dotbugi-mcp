import type { Keychain } from './types.js';

// Windows/macOS/Linux 네이티브 키체인. 네이티브 바이너리가 없어도 MCP 서버는 뜨도록 지연 import 한다
export function createNativeKeychain(service: string, account: string): Keychain {
  const entry = async () => new (await import('@napi-rs/keyring')).AsyncEntry(service, account);
  return {
    get: async () => (await entry()).getPassword(),
    set: async (value) => (await entry()).setPassword(value),
    delete: async () => (await entry()).deleteCredential(),
  };
}
