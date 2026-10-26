import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WSL_KEYCHAIN_TIMEOUT_MS } from '../constants.js';
import { createWslKeychain } from '../keychain/wsl.js';

// powershell.exe 흉내. hang: stdin 은 받기만 하고 kill 해야 close 한다, error: 실행 실패, 그 밖에는 stdin 을 다 받은 뒤 종료 코드로 끝난다
type Reply = 'hang' | 'error' | { code: number; stdout?: string };
const makeChild = (reply: Reply) => {
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    kill: vi.fn(() => child.emit('close', null)),
    unref: vi.fn(),
    input: '',
  });
  child.stdin.setEncoding('utf8').on('data', (d: string) => (child.input += d));
  if (reply === 'error') setImmediate(() => child.emit('error', new Error('ENOENT')));
  else if (reply !== 'hang')
    child.stdin.on('end', () => {
      child.stdout.end(reply.stdout ?? '');
      child.stdout.on('end', () => child.emit('close', reply.code));
      child.stdout.resume();
    });
  return child;
};
let reply: Reply = 'hang';
let child = makeChild('hang');
const spawn = vi.fn<(...a: unknown[]) => ReturnType<typeof makeChild>>(() => (child = makeChild(reply)));
vi.mock('node:child_process', () => ({ spawn: (...a: unknown[]) => spawn(...a) }));
vi.mock('../wsl-paths.js', () => ({ wslPowerShell: () => '/mnt/c/powershell.exe' }));

// -EncodedCommand 로 넘긴 스크립트 (UTF-16LE base64)
const script = () => Buffer.from((spawn.mock.calls.at(-1)?.[1] as string[]).at(-1)!, 'base64').toString('utf16le');
const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64');

beforeEach(() => void spawn.mockClear());
afterEach(() => vi.useRealTimers());

describe('WSL 키체인', () => {
  it('powershell 이 응답하지 않으면 시간 제한에 죽이고 고정 문구로 실패한다 (값을 담지 않음)', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    reply = 'hang';
    const result = createWslKeychain('svc', 'acc')
      .set('secret-session-value')
      .catch((e: unknown) => e as Error);
    await vi.advanceTimersByTimeAsync(WSL_KEYCHAIN_TIMEOUT_MS);
    const err = (await result) as Error;
    expect(child.kill).toHaveBeenCalledOnce();
    expect(child.unref).toHaveBeenCalledOnce();
    expect(child.stdout.destroyed).toBe(true);
    expect(err.message).toContain('응답하지 않았습니다');
    expect(err.message).not.toContain('secret');
  });

  it('값은 인자가 아니라 stdin 에 base64 로 넘기고, 대상 이름은 "{account}.{service}"', async () => {
    reply = { code: 0 };
    await createWslKeychain('svc', 'acc').set('세션값');
    expect(spawn.mock.calls[0][0]).toBe('/mnt/c/powershell.exe');
    expect(JSON.stringify(spawn.mock.calls[0])).not.toContain(b64('세션값'));
    expect(child.input).toBe(b64('세션값'));
    expect(script()).toContain("$target = 'acc.svc'; $account = 'acc'");
    expect(script()).toContain('CredWriteW');
  });

  it('읽은 값은 base64 를 풀어 돌려주고, 없으면(종료 코드 3) null', async () => {
    reply = { code: 0, stdout: `${b64('세션값')}\r\n` };
    expect(await createWslKeychain('svc', 'acc').get()).toBe('세션값');
    expect(script()).toContain('CredReadW');
    reply = { code: 3 };
    expect(await createWslKeychain('svc', 'acc').get()).toBeNull();
  });

  it('삭제는 지웠으면 true, 없으면 false', async () => {
    reply = { code: 0 };
    expect(await createWslKeychain('svc', 'acc').delete()).toBe(true);
    expect(script()).toContain('CredDeleteW');
    reply = { code: 3 };
    expect(await createWslKeychain('svc', 'acc').delete()).toBe(false);
  });

  it('그 밖의 실패는 동작별 고정 문구로, 실행조차 못 하면 그렇게 알린다', async () => {
    const kc = createWslKeychain('svc', 'acc');
    reply = { code: 1, stdout: 'garbage' };
    await expect(kc.get()).rejects.toThrow('읽지 못했습니다');
    await expect(kc.set('v')).rejects.toThrow('저장하지 못했습니다');
    await expect(kc.delete()).rejects.toThrow('삭제하지 못했습니다');
    reply = 'error';
    await expect(kc.get()).rejects.toThrow('powershell.exe 를 실행하지 못했습니다.');
  });
});
