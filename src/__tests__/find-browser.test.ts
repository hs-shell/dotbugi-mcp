import { delimiter, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// 디스크 대신 "있는 파일" 목록으로 판단한다 (isWsl 의 interop 파일 확인도 같은 목록을 본다)
const fs = vi.hoisted(() => ({ present: new Set<string>(), checked: [] as string[] }));
vi.mock('node:fs', async (orig) => ({
  ...(await orig<typeof import('node:fs')>()),
  existsSync: (p: string) => {
    fs.checked.push(p);
    return fs.present.has(p);
  },
}));
const wslLocalAppData = vi.fn<() => string | null>();
vi.mock('../wsl-paths.js', () => ({
  wslProgramFiles: () => ['/mnt/c/Program Files', '/mnt/c/Program Files (x86)'],
  wslLocalAppData: () => wslLocalAppData(),
}));

const { findBrowser } = await import('../login/find-browser.js');

const realPlatform = process.platform;
const setPlatform = (p: NodeJS.Platform) => Object.defineProperty(process, 'platform', { value: p });

beforeEach(() => {
  fs.present.clear();
  fs.checked = [];
  wslLocalAppData.mockReset().mockReturnValue(null);
  vi.stubEnv('WSL_DISTRO_NAME', '');
});
afterEach(() => {
  setPlatform(realPlatform);
  vi.unstubAllEnvs();
});

describe('findBrowser — Windows', () => {
  beforeEach(() => {
    setPlatform('win32');
    vi.stubEnv('PROGRAMFILES', 'C:\\Program Files');
    vi.stubEnv('PROGRAMFILES(X86)', '');
    vi.stubEnv('LOCALAPPDATA', 'C:\\Users\\u\\AppData\\Local');
  });

  it('Chrome → Edge 순으로, 비어 있는 루트는 건너뛰고 사용자 폴더(LOCALAPPDATA)까지 본다', () => {
    const edge = join('C:\\Program Files', 'Microsoft\\Edge\\Application\\msedge.exe');
    const userChrome = join('C:\\Users\\u\\AppData\\Local', 'Google\\Chrome\\Application\\chrome.exe');
    fs.present.add(edge).add(userChrome);
    // 사용자 폴더 Chrome 이 Program Files Edge 보다 먼저 (브라우저 우선순위가 먼저, 루트는 그 다음)
    expect(findBrowser()).toBe(userChrome);
    expect(fs.checked.slice(0, 2)).toEqual([
      join('C:\\Program Files', 'Google\\Chrome\\Application\\chrome.exe'),
      userChrome,
    ]);
  });

  it('없으면 null 이고 WSL 용 LocalAppData 조회는 하지 않는다', () => {
    expect(findBrowser()).toBeNull();
    expect(fs.checked).toHaveLength(8);
    expect(wslLocalAppData).not.toHaveBeenCalled();
  });
});

describe('findBrowser — macOS', () => {
  beforeEach(() => setPlatform('darwin'));

  it('/Applications 의 앱 번들 실행 파일을 Chrome → Edge → Brave → Whale 순으로', () => {
    fs.present.add('/Applications/Whale.app/Contents/MacOS/Whale');
    fs.present.add('/Applications/Brave Browser.app/Contents/MacOS/Brave Browser');
    expect(findBrowser()).toBe('/Applications/Brave Browser.app/Contents/MacOS/Brave Browser');
  });

  it('없으면 null', () => {
    expect(findBrowser()).toBeNull();
    expect(fs.checked).toHaveLength(4);
  });
});

describe('findBrowser — Linux', () => {
  beforeEach(() => setPlatform('linux'));

  it('PATH 의 절대경로만 본다 (빈 항목·상대경로 무시), 이름 우선순위가 PATH 순서보다 앞', () => {
    vi.stubEnv('PATH', ['/opt/bin', '', '.', 'bin', './local', '/usr/bin'].join(delimiter));
    fs.present.add(join('/opt/bin', 'chromium')).add(join('/usr/bin', 'google-chrome'));
    expect(findBrowser()).toBe(join('/usr/bin', 'google-chrome'));
    expect(fs.checked.filter((p) => p.endsWith('google-chrome'))).toEqual([
      join('/opt/bin', 'google-chrome'),
      join('/usr/bin', 'google-chrome'),
    ]);
  });

  it('PATH 가 없거나 상대경로뿐이면 아무 것도 찾지 않는다', () => {
    vi.stubEnv('PATH', ['', '.', 'bin'].join(delimiter));
    fs.present.add(join('bin', 'google-chrome')).add('google-chrome');
    expect(findBrowser()).toBeNull();
    expect(fs.checked.filter((p) => p.includes('chrom'))).toEqual([]);
  });

  it('WSL 이 아니면 LocalAppData 조회를 하지 않는다', () => {
    vi.stubEnv('PATH', '/usr/bin');
    expect(findBrowser()).toBeNull();
    expect(wslLocalAppData).not.toHaveBeenCalled();
  });
});

describe('findBrowser — WSL', () => {
  const pf = '/mnt/c/Program Files';
  beforeEach(() => {
    setPlatform('linux');
    vi.stubEnv('WSL_DISTRO_NAME', 'Ubuntu');
    vi.stubEnv('PATH', '/usr/bin');
    fs.present.add(join('/usr/bin', 'google-chrome'));
  });

  it('리눅스 PATH 대신 Windows Program Files 의 브라우저를, LocalAppData 조회 없이', () => {
    const edge = join(pf, 'Microsoft', 'Edge', 'Application', 'msedge.exe');
    fs.present.add(edge);
    expect(findBrowser()).toBe(edge);
    expect(wslLocalAppData).not.toHaveBeenCalled();
  });

  it('Program Files 에 없으면 LocalAppData(사용자 폴더 설치)에서 찾는다', () => {
    const local = '/mnt/c/Users/사용자/AppData/Local';
    const chrome = join(local, 'Google', 'Chrome', 'Application', 'chrome.exe');
    wslLocalAppData.mockReturnValue(local);
    fs.present.add(chrome);
    expect(findBrowser()).toBe(chrome);
    expect(wslLocalAppData).toHaveBeenCalledOnce();
  });

  it('LocalAppData 를 못 얻으면 null (리눅스 브라우저로 넘어가지 않는다)', () => {
    expect(findBrowser()).toBeNull();
    expect(wslLocalAppData).toHaveBeenCalledOnce();
  });
});
