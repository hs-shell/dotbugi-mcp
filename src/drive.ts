import { execFileSync } from 'node:child_process';
import { lstatSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, posix } from 'node:path';
import { WSL_LOOKUP_TIMEOUT_MS } from './constants.js';
import { isWsl } from './platform.js';
import { wslAutomountRoot, wslPowerShell } from './wsl-paths.js';

// Google Drive 데스크톱 앱의 "내 드라이브" 폴더 찾기. 공유 드라이브·"다른 컴퓨터" 는 후보로 삼지 않는다 (남과 함께 쓰는 폴더라 자료가 샌다)
export const MY_DRIVE_NAMES = ['My Drive', '내 드라이브'];

export interface DriveDetection {
  // 쓸 수 있는 "내 드라이브" 폴더
  roots: string[];
  // WSL: Windows 에는 있지만 WSL 에 마운트되지 않은 드라이브 문자 (대문자)
  unmounted: string[];
}

const isRealDir = (p: string) => lstatSync(p, { throwIfNoEntry: false })?.isDirectory() === true;

// 바탕 폴더들 안에서 "내 드라이브" 가 실제 폴더(링크 아님)로 있는 것
export function myDrivesIn(parents: string[], isDir = isRealDir): string[] {
  return parents.flatMap((parent) => MY_DRIVE_NAMES.map((name) => join(parent, name)).filter((p) => isDir(p)));
}

// macOS: ~/Library/CloudStorage/GoogleDrive-<계정>/
function macParents(): string[] {
  const dir = join(homedir(), 'Library', 'CloudStorage');
  try {
    return readdirSync(dir)
      .filter((n) => n.startsWith('GoogleDrive-'))
      .map((n) => join(dir, n));
  } catch {
    return [];
  }
}

// Windows: Drive 는 가상 드라이브(G: 등)로 붙는다 — A·B·C 를 뺀 문자를 본다
const windowsParents = () => [...'DEFGHIJKLMNOPQRSTUVWXYZ'].map((l) => `${l}:\\`);

// WSL 에서 Windows 쪽 드라이브 중 "내 드라이브" 가 있는 문자. 한글 폴더명은 콘솔 코드페이지(CP949)에서 깨지므로
// 스크립트는 -EncodedCommand(UTF-16)로 넘기고, 출력은 ASCII 드라이브 문자만 받는다
const LETTERS_SCRIPT = `$n=@(${MY_DRIVE_NAMES.map((n) => `'${n}'`).join(',')}); (Get-PSDrive -PSProvider FileSystem | Where-Object { $r=$_.Root; @($n | Where-Object { Test-Path -LiteralPath (Join-Path $r $_) }).Count -gt 0 } | ForEach-Object { $_.Name }) -join ','`;

export function parseDriveLetters(out: string): string[] {
  const s = out.trim().toUpperCase();
  return /^[A-Z](,[A-Z])*$/.test(s) ? [...new Set(s.split(','))].filter((l) => l !== 'C') : [];
}

function wslDriveLetters(): string[] {
  try {
    const out = execFileSync(
      wslPowerShell(),
      ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(LETTERS_SCRIPT, 'utf16le').toString('base64')],
      {
        // UNC(\\wsl$) 작업 폴더 경고를 피하려고 Windows 드라이브에서 실행
        cwd: `${wslAutomountRoot()}c`,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: WSL_LOOKUP_TIMEOUT_MS,
      }
    );
    return parseDriveLetters(out);
  } catch {
    return [];
  }
}

// WSL: 문자별로 /mnt/<문자> 가 마운트돼 있으면 그 안의 "내 드라이브", 아니면 unmounted
export function wslDetection(letters: string[], root: string, isDir = isRealDir): DriveDetection {
  const roots: string[] = [];
  const unmounted: string[] = [];
  for (const l of letters) {
    const found = MY_DRIVE_NAMES.map((n) => posix.join(root, l.toLowerCase(), n)).filter((p) => isDir(p));
    if (found.length) roots.push(...found);
    else unmounted.push(l);
  }
  return { roots, unmounted };
}

export function detectGoogleDrive(): DriveDetection {
  if (isWsl()) return wslDetection(wslDriveLetters(), wslAutomountRoot());
  if (process.platform === 'darwin') return { roots: myDrivesIn(macParents()), unmounted: [] };
  if (process.platform === 'win32') return { roots: myDrivesIn(windowsParents()), unmounted: [] };
  // Linux 용 공식 Drive 앱은 없다
  return { roots: [], unmounted: [] };
}

// WSL 가상 드라이브는 자동 마운트되지 않는다 — 리눅스 쪽에서 sudo 로 한 번 붙여야 하며 MCP 가 대신할 방법이 없다
export const wslMountCommand = (letter: string, root = wslAutomountRoot()) => {
  const dir = posix.join(root, letter.toLowerCase());
  return `sudo mkdir -p ${dir} && sudo mount -t drvfs ${letter}: ${dir}`;
};
// Claude Code 의 ! 입력처럼 비밀번호를 받을 터미널이 없어도 되는 방식 — Windows 쪽 wsl.exe 로 root 실행
export const wslRootMountCommand = (letter: string, root = wslAutomountRoot()) => {
  const dir = posix.join(root, letter.toLowerCase());
  return `wsl.exe -u root -e sh -c "mkdir -p ${dir} && mount -t drvfs ${letter}: ${dir}"`;
};
export const wslFstabLine = (letter: string, root = wslAutomountRoot()) =>
  `${letter}: ${posix.join(root, letter.toLowerCase())} drvfs defaults 0 0`;
// 마운트되지 않은 WSL 드라이브를 붙이는 방법 — find_google_drive 와 저장 위치가 사라졌을 때(ensureStorageRoot) 같은 안내
export const wslMountSteps = (letter: string) => [
  `Claude Code 입력창에서 바로 (비밀번호 불필요): ! ${wslRootMountCommand(letter)}`,
  `또는 별도 WSL 터미널에서 (비밀번호 입력): ${wslMountCommand(letter)}`,
  `WSL 을 다시 켜도 유지하려면 /etc/fstab 에 한 줄 추가: ${wslFstabLine(letter)}`,
];
