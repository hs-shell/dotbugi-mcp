import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { posix } from 'node:path';
import { WSL_CONF_FILE, WSL_DEFAULT_AUTOMOUNT_ROOT, WSL_LOOKUP_TIMEOUT_MS } from './constants.js';

// WSL 에서 Windows 실행 파일·폴더 위치. /etc/wsl.conf 의 automount root 를 바꾼 환경(/mnt/c 가 아닌 곳)도 따른다

// wsl.conf [automount] root 값. 없거나 이상하면 기본값 (외부 파일이라 절대경로·제어문자 없음만 받는다)
export function parseAutomountRoot(conf: string): string {
  let section = '';
  let root: string | null = null;
  for (const raw of conf.split(/\r?\n/)) {
    const line = raw.replace(/[#;].*$/, '').trim();
    const header = /^\[(.+)\]$/.exec(line);
    if (header) {
      section = header[1].trim().toLowerCase();
      continue;
    }
    const kv = /^([^=]+)=(.*)$/.exec(line);
    if (section === 'automount' && kv && kv[1].trim().toLowerCase() === 'root') {
      root = kv[2].trim().replace(/^"(.*)"$/, '$1');
    }
  }
  // eslint-disable-next-line no-control-regex
  if (!root || !root.startsWith('/') || /[\x00-\x1f]/.test(root)) return WSL_DEFAULT_AUTOMOUNT_ROOT;
  return posix.normalize(root.endsWith('/') ? root : `${root}/`);
}

let automountRoot: string | undefined;
export function wslAutomountRoot(): string {
  if (automountRoot === undefined) {
    let conf = '';
    try {
      conf = readFileSync(WSL_CONF_FILE, 'utf8');
    } catch {
      // 파일이 없으면 기본 위치
    }
    automountRoot = parseAutomountRoot(conf);
  }
  return automountRoot;
}

// 'C:\Users\x' → '<root>c/Users/x'. 드라이브 경로가 아니거나 이상한 글자가 있으면 null
export function windowsToWslPath(winPath: string, root: string): string | null {
  // eslint-disable-next-line no-control-regex
  const m = /^([A-Za-z]):\\([^\0-\x1f"<>|*?/]*)$/.exec(winPath);
  if (!m || m[2].split('\\').includes('..')) return null;
  return posix.join(root, m[1].toLowerCase(), ...m[2].split('\\').filter(Boolean));
}

// shortcut: Windows 가 C: 에 설치됐다고 가정, 다른 드라이브 설치 요청이 있으면 %SystemRoot% 로 해석한다
const systemDrive = (): string => `${wslAutomountRoot()}c`;
export const wslPowerShell = (): string => `${systemDrive()}/WINDOWS/System32/WindowsPowerShell/v1.0/powershell.exe`;
export const wslRundll32 = (): string => `${systemDrive()}/WINDOWS/System32/rundll32.exe`;
export const wslProgramFiles = (): string[] => [
  `${systemDrive()}/Program Files`,
  `${systemDrive()}/Program Files (x86)`,
];

// 사용자 폴더 설치 브라우저용 %LOCALAPPDATA%. 콘솔 코드페이지(한글 사용자명이 깨짐)를 피하려고 base64 UTF-8 로 받는다
const LOCAL_APP_DATA_SCRIPT =
  "[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes([Environment]::GetFolderPath('LocalApplicationData')))";
let localAppData: string | null | undefined;
export function wslLocalAppData(): string | null {
  if (localAppData !== undefined) return localAppData;
  localAppData = null;
  try {
    const out = execFileSync(wslPowerShell(), ['-NoProfile', '-NonInteractive', '-Command', LOCAL_APP_DATA_SCRIPT], {
      // UNC(\\wsl$) 작업 폴더 경고를 피하려고 Windows 드라이브에서 실행
      cwd: systemDrive(),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: WSL_LOOKUP_TIMEOUT_MS,
    });
    localAppData = windowsToWslPath(Buffer.from(out.trim(), 'base64').toString('utf8'), wslAutomountRoot());
  } catch {
    // 못 찾으면 사용자 설치 후보만 건너뛴다
  }
  return localAppData;
}
