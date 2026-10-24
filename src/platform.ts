import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { delimiter, isAbsolute, join } from 'node:path';
import { WSL_INTEROP_FILE } from './constants.js';
import { wslRundll32 } from './wsl-paths.js';

// PATH 중 절대경로 항목만 쓴다 (빈 항목·'.' 같은 상대경로는 현재 폴더의 같은 이름 파일을 실행하게 만든다)
export function absolutePathDirs(): string[] {
  return (process.env.PATH ?? '').split(delimiter).filter((d) => isAbsolute(d));
}

export function isWsl(): boolean {
  return process.platform === 'linux' && (existsSync(WSL_INTEROP_FILE) || Boolean(process.env.WSL_DISTRO_NAME));
}

// 기본 브라우저로 URL 열기. 셸을 거치지 않는다 (cmd start 는 & 를 특수문자로 해석해 URL이 잘린다)
export function openUrl(url: string): Promise<void> {
  const [cmd, args] = opener(url);
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: 'ignore' });
    child.once('error', () => reject(new Error('기본 브라우저를 열지 못했습니다.')));
    child.once('spawn', () => {
      child.unref();
      resolve();
    });
  });
}

function opener(url: string): [string, string[]] {
  if (isWsl()) return [wslRundll32(), ['url.dll,FileProtocolHandler', url]];
  if (process.platform === 'win32') {
    const rundll32 = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'rundll32.exe');
    return [rundll32, ['url.dll,FileProtocolHandler', url]];
  }
  if (process.platform === 'darwin') return ['/usr/bin/open', [url]];
  const xdgOpen = absolutePathDirs()
    .map((d) => join(d, 'xdg-open'))
    .find((p) => existsSync(p));
  if (!xdgOpen) throw new Error('xdg-open 을 찾지 못해 기본 브라우저를 열 수 없습니다.');
  return [xdgOpen, [url]];
}
