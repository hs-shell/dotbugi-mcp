import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { WSL_PROGRAM_FILES } from '../constants.js';
import { absolutePathDirs, isWsl } from '../platform.js';

// 설치된 Chromium 계열 브라우저 탐색 순서: Chrome → Edge → Brave → Whale
const WINDOWS_PATHS = [
  'Google\\Chrome\\Application\\chrome.exe',
  'Microsoft\\Edge\\Application\\msedge.exe',
  'BraveSoftware\\Brave-Browser\\Application\\brave.exe',
  'Naver\\Naver Whale\\Application\\whale.exe',
];
const MAC_PATHS = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
  '/Applications/Whale.app/Contents/MacOS/Whale',
];
const LINUX_NAMES = [
  'google-chrome',
  'google-chrome-stable',
  'chromium',
  'chromium-browser',
  'microsoft-edge',
  'brave-browser',
  'naver-whale',
];

export function findBrowser(): string | null {
  return candidates().find((p) => existsSync(p)) ?? null;
}

function candidates(): string[] {
  const env = process.env;
  if (process.platform === 'win32') {
    const roots = [env.PROGRAMFILES, env['PROGRAMFILES(X86)'], env.LOCALAPPDATA].filter((r): r is string => !!r);
    return WINDOWS_PATHS.flatMap((p) => roots.map((r) => join(r, p)));
  }
  if (process.platform === 'darwin') return MAC_PATHS;
  // WSL 에선 Windows 브라우저(평소 프로필)를 interop 으로 직접 실행한다
  if (isWsl()) return WINDOWS_PATHS.flatMap((p) => WSL_PROGRAM_FILES.map((r) => join(r, ...p.split('\\'))));
  const dirs = absolutePathDirs();
  return LINUX_NAMES.flatMap((name) => dirs.map((d) => join(d, name)));
}
