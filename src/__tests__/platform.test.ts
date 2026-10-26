import { EventEmitter } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WSL_INTEROP_FILE } from '../constants.js';
import { absolutePathDirs, isWsl, openUrl } from '../platform.js';
import { wslRundll32 } from '../wsl-paths.js';

// WSL 여부는 실행 환경이 아니라 테스트 값으로
const state = vi.hoisted(() => ({ interop: false, spawnError: false }));
vi.mock('node:fs', async (orig) => {
  const fs = await orig<typeof import('node:fs')>();
  return { ...fs, existsSync: (p: string) => (p === WSL_INTEROP_FILE ? state.interop : fs.existsSync(p)) };
});
const spawn = vi.fn<(...a: unknown[]) => EventEmitter>(() => {
  const child = Object.assign(new EventEmitter(), { unref: vi.fn() });
  setImmediate(() => (state.spawnError ? child.emit('error', new Error('ENOENT')) : child.emit('spawn')));
  return child;
});
vi.mock('node:child_process', () => ({ spawn: (...a: unknown[]) => spawn(...a) }));

const URL_WITH_AMP = 'https://learn.hansung.ac.kr/login?a=1&b=2';
const real = { platform: process.platform, path: process.env.PATH, distro: process.env.WSL_DISTRO_NAME };
const setPlatform = (p: NodeJS.Platform) =>
  Object.defineProperty(process, 'platform', { value: p, configurable: true });
let bin: string;

beforeEach(async () => {
  bin = await mkdtemp(join(tmpdir(), 'dotbugi-platform-'));
  state.interop = false;
  state.spawnError = false;
  delete process.env.WSL_DISTRO_NAME;
  spawn.mockClear();
});
afterEach(async () => {
  setPlatform(real.platform);
  process.env.PATH = real.path;
  if (real.distro === undefined) delete process.env.WSL_DISTRO_NAME;
  else process.env.WSL_DISTRO_NAME = real.distro;
  await rm(bin, { recursive: true, force: true });
});

describe('absolutePathDirs', () => {
  it('PATH 의 빈 항목·상대경로는 버린다', () => {
    process.env.PATH = ['', '.', 'node_modules/.bin', bin].join(delimiter);
    expect(absolutePathDirs()).toEqual([bin]);
  });
});

describe('isWsl', () => {
  it('Linux 에서 WSLInterop 이 있거나 WSL_DISTRO_NAME 이 있으면 WSL', () => {
    setPlatform('linux');
    expect(isWsl()).toBe(false);
    state.interop = true;
    expect(isWsl()).toBe(true);
    state.interop = false;
    process.env.WSL_DISTRO_NAME = 'Ubuntu';
    expect(isWsl()).toBe(true);
    setPlatform('darwin');
    expect(isWsl()).toBe(false);
  });
});

describe('openUrl', () => {
  it('셸 없이 URL 을 인자 하나로 넘긴다 (& 가 잘리지 않음) — macOS 는 /usr/bin/open', async () => {
    setPlatform('darwin');
    await openUrl(URL_WITH_AMP);
    expect(spawn).toHaveBeenCalledWith('/usr/bin/open', [URL_WITH_AMP], { stdio: 'ignore' });
  });

  it('Windows·WSL 은 rundll32 의 FileProtocolHandler', async () => {
    setPlatform('win32');
    await openUrl(URL_WITH_AMP);
    expect(spawn.mock.calls[0][0]).toMatch(/System32[\\/]rundll32\.exe$/);
    expect(spawn.mock.calls[0][1]).toEqual(['url.dll,FileProtocolHandler', URL_WITH_AMP]);
    setPlatform('linux');
    state.interop = true;
    await openUrl(URL_WITH_AMP);
    expect(spawn.mock.calls[1]).toEqual([
      wslRundll32(),
      ['url.dll,FileProtocolHandler', URL_WITH_AMP],
      { stdio: 'ignore' },
    ]);
  });

  it('Linux 는 PATH 의 절대경로에서 찾은 xdg-open, 없으면 실행하지 않고 오류', async () => {
    setPlatform('linux');
    process.env.PATH = ['.', bin].join(delimiter);
    expect(() => openUrl(URL_WITH_AMP)).toThrow('xdg-open 을 찾지 못해');
    expect(spawn).not.toHaveBeenCalled();
    await writeFile(join(bin, 'xdg-open'), '');
    await openUrl(URL_WITH_AMP);
    expect(spawn).toHaveBeenCalledWith(join(bin, 'xdg-open'), [URL_WITH_AMP], { stdio: 'ignore' });
  });

  it('실행에 실패하면 고정 문구로 거부한다', async () => {
    setPlatform('darwin');
    state.spawnError = true;
    await expect(openUrl(URL_WITH_AMP)).rejects.toThrow('기본 브라우저를 열지 못했습니다.');
  });
});
