import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getKeychain } from '../keychain/index.js';
import { createNativeKeychain } from '../keychain/native.js';
import { createWslKeychain } from '../keychain/wsl.js';
import { isWsl } from '../platform.js';

vi.mock('../platform.js', () => ({ isWsl: vi.fn() }));
vi.mock('../keychain/wsl.js', () => ({ createWslKeychain: vi.fn(() => 'wsl') }));
vi.mock('../keychain/native.js', () => ({ createNativeKeychain: vi.fn(() => 'native') }));

beforeEach(() => vi.clearAllMocks());

describe('getKeychain', () => {
  it('WSL 이면 Windows 자격 증명 관리자 어댑터', () => {
    vi.mocked(isWsl).mockReturnValue(true);
    expect(getKeychain()).toBe('wsl');
    expect(createWslKeychain).toHaveBeenCalledWith('dotbugi-mcp', 'session');
    expect(createNativeKeychain).not.toHaveBeenCalled();
  });

  it('그 외에는 네이티브 키체인', () => {
    vi.mocked(isWsl).mockReturnValue(false);
    expect(getKeychain()).toBe('native');
    expect(createNativeKeychain).toHaveBeenCalledWith('dotbugi-mcp', 'session');
    expect(createWslKeychain).not.toHaveBeenCalled();
  });
});
