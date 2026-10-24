import { describe, expect, it } from 'vitest';
import { parseAutomountRoot, windowsToWslPath } from '../wsl-paths.js';

describe('parseAutomountRoot', () => {
  it('[automount] root 를 읽는다', () => {
    expect(parseAutomountRoot('[boot]\nsystemd=true\n[automount]\nroot = /windir/\n')).toBe('/windir/');
    expect(parseAutomountRoot('[Automount]\r\nroot="/win" # 주석\r\n')).toBe('/win/');
  });
  it('없거나 이상하면 /mnt/', () => {
    expect(parseAutomountRoot('')).toBe('/mnt/');
    expect(parseAutomountRoot('[boot]\nroot=/other/\n')).toBe('/mnt/');
    expect(parseAutomountRoot('[automount]\nroot=relative/\n')).toBe('/mnt/');
    expect(parseAutomountRoot('[automount]\nroot=/a\tb/\n')).toBe('/mnt/');
  });
});

describe('windowsToWslPath', () => {
  it('드라이브 경로를 마운트 위치로 바꾼다', () => {
    expect(windowsToWslPath('C:\\Users\\김\\AppData\\Local', '/mnt/')).toBe('/mnt/c/Users/김/AppData/Local');
    expect(windowsToWslPath('D:\\Data\\', '/windir/')).toBe('/windir/d/Data');
  });
  it('드라이브 경로가 아니거나 이상한 값은 거절', () => {
    for (const bad of [
      '%LOCALAPPDATA%',
      '\\\\server\\share',
      'C:\\Users\\x\nC:\\evil',
      'C:\\Users\\..\\..\\etc',
      'C:\\a/../../etc',
      '',
    ]) {
      expect(windowsToWslPath(bad, '/mnt/')).toBeNull();
    }
  });
});
