import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WSL_KEYCHAIN_TIMEOUT_MS } from '../constants.js';
import { createWslKeychain } from '../keychain/wsl.js';

// 응답하지 않는 powershell.exe 흉내: stdin 은 받기만 하고, kill 해야 close 한다
const child = Object.assign(new EventEmitter(), {
  stdin: new PassThrough(),
  stdout: new PassThrough(),
  kill: vi.fn(() => child.emit('close', null)),
});
vi.mock('node:child_process', () => ({ spawn: vi.fn(() => child) }));
vi.mock('../wsl-paths.js', () => ({ wslPowerShell: () => '/mnt/c/powershell.exe' }));

afterEach(() => vi.useRealTimers());

describe('WSL 키체인', () => {
  it('powershell 이 응답하지 않으면 시간 제한에 죽이고 고정 문구로 실패한다 (값을 담지 않음)', async () => {
    vi.useFakeTimers();
    const result = createWslKeychain('svc', 'acc')
      .set('secret-session-value')
      .catch((e: unknown) => e as Error);
    await vi.advanceTimersByTimeAsync(WSL_KEYCHAIN_TIMEOUT_MS);
    const err = (await result) as Error;
    expect(child.kill).toHaveBeenCalledOnce();
    expect(err.message).toContain('응답하지 않았습니다');
    expect(err.message).not.toContain('secret');
  });
});
