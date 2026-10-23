import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { WSL_INTEROP_FILE, WSL_RUNDLL32 } from './constants.js';

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
  if (isWsl()) return [WSL_RUNDLL32, ['url.dll,FileProtocolHandler', url]];
  if (process.platform === 'win32') {
    const rundll32 = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'rundll32.exe');
    return [rundll32, ['url.dll,FileProtocolHandler', url]];
  }
  if (process.platform === 'darwin') return ['/usr/bin/open', [url]];
  return ['xdg-open', [url]];
}
