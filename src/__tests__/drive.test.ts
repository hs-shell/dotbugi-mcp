import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  detectGoogleDrive,
  myDrivesIn,
  parseDriveLetters,
  wslDetection,
  wslFstabLine,
  wslMountCommand,
} from '../drive.js';
import { describeDrive } from '../tools/storage-dir.js';
import { wslAutomountRoot } from '../wsl-paths.js';

// 실제 홈·실제 PowerShell 대신 테스트 값
const state = vi.hoisted(() => ({ home: '', wsl: false, letters: null as string | null }));
vi.mock('node:os', async (orig) => ({ ...(await orig<typeof import('node:os')>()), homedir: () => state.home }));
vi.mock('../platform.js', async (orig) => ({
  ...(await orig<typeof import('../platform.js')>()),
  isWsl: () => state.wsl,
}));
const execFileSync = vi.fn<(...a: unknown[]) => string>(() => {
  if (state.letters === null) throw new Error('timeout');
  return state.letters;
});
vi.mock('node:child_process', async (orig) => ({
  ...(await orig<typeof import('node:child_process')>()),
  execFileSync: (...a: unknown[]) => execFileSync(...a),
}));

// 디스크 대신 "있는 폴더" 목록으로 판단한다
const dirs =
  (...list: string[]) =>
  (p: string) =>
    list.includes(p);
const EMOJI = /\p{Extended_Pictographic}/u;

describe('myDrivesIn', () => {
  it('"내 드라이브"/"My Drive" 만 고르고 공유 드라이브·다른 컴퓨터는 무시한다', () => {
    const a = join('cs', 'GoogleDrive-a');
    const b = join('cs', 'GoogleDrive-b');
    const isDir = dirs(join(a, 'My Drive'), join(a, 'Shared drives'), join(b, '내 드라이브'));
    expect(myDrivesIn([a, b, join('cs', 'none')], isDir)).toEqual([join(a, 'My Drive'), join(b, '내 드라이브')]);
  });
});

describe('parseDriveLetters', () => {
  it('드라이브 문자만 받고 C 와 중복은 뺀다', () => {
    expect(parseDriveLetters('G\r\n')).toEqual(['G']);
    expect(parseDriveLetters('c,g,G,H')).toEqual(['G', 'H']);
  });
  it('이상한 출력은 버린다', () => {
    for (const bad of ['', 'G:', 'G; rm -rf', '\u001b[31mG', 'GH']) expect(parseDriveLetters(bad)).toEqual([]);
  });
});

describe('wslDetection', () => {
  it('마운트된 문자는 내 드라이브 경로, 아니면 unmounted', () => {
    expect(wslDetection(['G', 'H'], '/mnt/', dirs('/mnt/g/내 드라이브'))).toEqual({
      roots: ['/mnt/g/내 드라이브'],
      unmounted: ['H'],
    });
  });
  it('마운트 명령은 automount root 를 따른다', () => {
    expect(wslMountCommand('G', '/mnt/')).toBe('sudo mkdir -p /mnt/g && sudo mount -t drvfs G: /mnt/g');
    expect(wslFstabLine('G', '/win/')).toBe('G: /win/g drvfs defaults 0 0');
  });
});

describe('describeDrive', () => {
  it('찾으면 <내 드라이브>/돋부기 를 추천한다', () => {
    const r = describeDrive({ roots: ['/mnt/g/내 드라이브'], unmounted: [] }, '/home/u/Downloads/dotbugi-mcp');
    expect(r.suggested).toBe(join('/mnt/g/내 드라이브', '돋부기'));
    expect(r.guidance).toContain('set_storage_dir');
    expect(r.guidance).not.toMatch(EMOJI);
  });
  it('WSL 에서 마운트되지 않았으면 마운트 명령을 알려 준다', () => {
    const r = describeDrive({ roots: [], unmounted: ['G'] }, '/x');
    expect(r.suggested).toBeNull();
    expect(r.guidance).toContain('sudo mount -t drvfs G:');
    expect(r.guidance).toContain('/etc/fstab');
    // Claude Code 의 ! 입력은 sudo 비밀번호를 받을 수 없어 wsl.exe -u root 방식도 함께 안내한다
    expect(r.guidance).toMatch(/! wsl\.exe -u root -e sh -c "mkdir -p \S+\/g && mount -t drvfs G: \S+\/g"/);
    expect(r.guidance).not.toMatch(EMOJI);
  });
  it('없으면 설치 안내', () => {
    expect(describeDrive({ roots: [], unmounted: [] }, '/x').guidance).toContain('google.com/drive/download');
  });
});

describe('detectGoogleDrive', () => {
  const realPlatform = process.platform;
  const setPlatform = (p: NodeJS.Platform) =>
    Object.defineProperty(process, 'platform', { value: p, configurable: true });
  beforeEach(async () => {
    state.home = await mkdtemp(join(tmpdir(), 'dotbugi-drive-'));
    state.wsl = false;
    execFileSync.mockClear();
  });
  afterEach(async () => {
    setPlatform(realPlatform);
    await rm(state.home, { recursive: true, force: true });
  });

  it('macOS 는 CloudStorage/GoogleDrive-<계정> 안의 내 드라이브만 (링크·다른 폴더는 무시)', async () => {
    setPlatform('darwin');
    const cs = join(state.home, 'Library', 'CloudStorage');
    expect(detectGoogleDrive()).toEqual({ roots: [], unmounted: [] });
    await mkdir(join(cs, 'GoogleDrive-a@x.com', '내 드라이브'), { recursive: true });
    await mkdir(join(cs, 'GoogleDrive-a@x.com', '공유 드라이브'), { recursive: true });
    await mkdir(join(cs, 'OneDrive', 'My Drive'), { recursive: true });
    expect(detectGoogleDrive()).toEqual({ roots: [join(cs, 'GoogleDrive-a@x.com', '내 드라이브')], unmounted: [] });
  });

  it.skipIf(process.platform === 'win32')('macOS 의 내 드라이브가 링크면 쓰지 않는다', async () => {
    setPlatform('darwin');
    const account = join(state.home, 'Library', 'CloudStorage', 'GoogleDrive-a@x.com');
    await mkdir(account, { recursive: true });
    await symlink(state.home, join(account, 'My Drive'));
    expect(detectGoogleDrive().roots).toEqual([]);
  });

  it('Linux 는 공식 Drive 앱이 없어 찾지 않는다', () => {
    setPlatform('linux');
    expect(detectGoogleDrive()).toEqual({ roots: [], unmounted: [] });
  });

  it('WSL 은 PowerShell 이 알려 준 드라이브 문자 중 마운트 안 된 것을 알리고, 조회 실패는 빈 결과', () => {
    setPlatform('linux');
    state.wsl = true;
    state.letters = 'C,G\r\n';
    expect(detectGoogleDrive()).toEqual({ roots: [], unmounted: ['G'] });
    // 한글 폴더명이 깨지지 않게 스크립트는 -EncodedCommand 로만 넘긴다
    const [, args, opts] = execFileSync.mock.calls[0] as [string, string[], { cwd: string }];
    expect(args.slice(0, 3)).toEqual(['-NoProfile', '-NonInteractive', '-EncodedCommand']);
    expect(Buffer.from(args[3], 'base64').toString('utf16le')).toContain("'내 드라이브'");
    expect(opts.cwd).toBe(`${wslAutomountRoot()}c`);
    state.letters = null;
    expect(detectGoogleDrive()).toEqual({ roots: [], unmounted: [] });
  });
});
