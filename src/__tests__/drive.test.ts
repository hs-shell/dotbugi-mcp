import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { myDrivesIn, parseDriveLetters, wslDetection, wslFstabLine, wslMountCommand } from '../drive.js';
import { describeDrive } from '../tools/storage-dir.js';

// 디스크 대신 "있는 폴더" 목록으로 판단한다
const dirs =
  (...list: string[]) =>
  (p: string) =>
    list.includes(p);
const EMOJI = /\p{Extended_Pictographic}/u;

describe('myDrivesIn', () => {
  it('"내 드라이브"/"My Drive" 만 고르고 공유 드라이브·다른 컴퓨터는 무시한다', () => {
    const isDir = dirs(
      '/cs/GoogleDrive-a/My Drive',
      '/cs/GoogleDrive-a/Shared drives',
      '/cs/GoogleDrive-b/내 드라이브'
    );
    expect(myDrivesIn(['/cs/GoogleDrive-a', '/cs/GoogleDrive-b', '/cs/none'], isDir)).toEqual([
      '/cs/GoogleDrive-a/My Drive',
      '/cs/GoogleDrive-b/내 드라이브',
    ]);
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
    expect(r.text).toContain('set_storage_dir');
    expect(r.text).not.toMatch(EMOJI);
  });
  it('WSL 에서 마운트되지 않았으면 마운트 명령을 알려 준다', () => {
    const r = describeDrive({ roots: [], unmounted: ['G'] }, '/x');
    expect(r.suggested).toBeNull();
    expect(r.text).toContain('sudo mount -t drvfs G:');
    expect(r.text).toContain('/etc/fstab');
    expect(r.text).not.toMatch(EMOJI);
  });
  it('없으면 설치 안내', () => {
    expect(describeDrive({ roots: [], unmounted: [] }, '/x').text).toContain('google.com/drive/download');
  });
});
