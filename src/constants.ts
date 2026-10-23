// 보안상 고정해야 하는 값과 시간 제한을 한곳에 모은다

export const LMS_HOST = 'learn.hansung.ac.kr';
// 세션 쿠키는 정확히 이 출처로만 보낸다
export const LMS_ORIGIN = `https://${LMS_HOST}`;
export const LMS_HOME_PATH = '/my/';
export const LMS_LOGIN_PAGE_PATH = '/login/index.php';
export const LMS_LOGOUT_PATH = '/login/logout.php';
export const SESSION_COOKIE = 'MoodleSession';
// 로그인 관련 URL(/login.php, /login/index.php …)은 모두 경로에 login 이 들어간다
export const LOGIN_URL_MARKER = 'login';
export const SESSION_PATTERN = /^[A-Za-z0-9,-]{20,128}$/;
export const SESSKEY_PATTERN = /"sesskey":"([A-Za-z0-9]+)"/;

export const KEYCHAIN_SERVICE = 'dotbugi-mcp';
export const KEYCHAIN_ACCOUNT = 'session';

// dotbugi 확장 ID (공개값). 정식·베타 스토어 항목. build:local 은 정식과 같은 ID를 쓴다
export const DOTBUGI_EXTENSION_IDS = ['fbhdnbombekihdhjcfiimiibfmikghch', 'dmegmajemhcacnglbpfmokpiiefmjdej'] as const;
export const CONNECT_HASH_KEY = 'dotbugi-connect';
export const CALLBACK_HOST = '127.0.0.1';
export const CALLBACK_PATH = '/cb';
export const CALLBACK_MAX_BODY_BYTES = 4096;
export const LOGIN_TIMEOUT_MS = 5 * 60_000;

// 브라우저 시작이 느린 첫 호출도 넉넉히 기다리되, 응답이 없으면 멈추지 않도록 끊는다
export const CDP_CALL_TIMEOUT_MS = 15_000;
export const POLL_INTERVAL_MS = 1000;
export const BROWSER_EXIT_WAIT_MS = 5000;
// 셸 관례: 128 + 시그널 번호
export const SIGNAL_EXIT_CODES = { SIGINT: 130, SIGTERM: 143 } as const;

// shortcut: Windows C: 드라이브가 /mnt/c 에 마운트됐다고 가정, automount root 를 바꾼 환경이면 wslpath 로 해석하도록 바꾼다
export const WSL_POWERSHELL = '/mnt/c/WINDOWS/System32/WindowsPowerShell/v1.0/powershell.exe';
export const WSL_RUNDLL32 = '/mnt/c/WINDOWS/System32/rundll32.exe';
export const WSL_INTEROP_FILE = '/proc/sys/fs/binfmt_misc/WSLInterop';
