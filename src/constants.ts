// 보안상 고정해야 하는 값과 시간 제한을 한곳에 모은다

export const LMS_HOST = 'learn.hansung.ac.kr';
// 세션 쿠키는 정확히 이 출처로만 보낸다
export const LMS_ORIGIN = `https://${LMS_HOST}`;
export const LMS_HOME_PATH = '/my/';
export const LMS_LOGIN_PAGE_PATH = '/login/index.php';
export const LMS_LOGOUT_PATH = '/login/logout.php';
// 내 강좌 목록(.my-course-lists)이 있는 LMS 메인. dotbugi 확장도 이 페이지에서 과목을 읽는다
export const LMS_COURSE_LIST_PATH = '/';
// @dotbugi/lms-parser parseCoursesFromDOM 이 읽는 '.my-course-lists > li' 의 목록 컨테이너
export const LMS_COURSE_LIST_SELECTOR = '.my-course-lists';
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
export const SIGNAL_EXIT_CODES = { SIGHUP: 129, SIGINT: 130, SIGTERM: 143 } as const;

// shortcut: Windows C: 드라이브가 /mnt/c 에 마운트됐다고 가정, automount root 를 바꾼 환경이면 wslpath 로 해석하도록 바꾼다
export const WSL_POWERSHELL = '/mnt/c/WINDOWS/System32/WindowsPowerShell/v1.0/powershell.exe';
export const WSL_RUNDLL32 = '/mnt/c/WINDOWS/System32/rundll32.exe';
export const WSL_INTEROP_FILE = '/proc/sys/fs/binfmt_misc/WSLInterop';

// LMS 화면의 날짜는 한국 시간이다 (실행 환경 시간대와 무관하게 해석)
export const LMS_UTC_OFFSET = '+09:00';
// 과목이 많아도 LMS 에 동시에 보내는 요청 수를 제한한다
export const LMS_MAX_CONCURRENT_REQUESTS = 3;
// LMS 가 응답하지 않아도 도구 호출이 끝나도록 요청마다 끊는다 (본문 수신 포함)
export const LMS_REQUEST_TIMEOUT_MS = 20_000;
// dotbugi 확장과 같은 1시간 캐시
export const TASKS_CACHE_TTL_MS = 60 * 60_000;
// list_tasks 과목명 필터 입력 길이 상한
export const COURSE_FILTER_MAX_LENGTH = 100;
// 공식 VOD 플레이어 페이지. 여는 주소는 숫자 cmid 로만 만든다
export const VOD_PLAYER_PATH = '/mod/vod/view.php';
export const LMS_NUMERIC_ID = /^\d{1,10}$/;
// 서버 진도 확인 간격 (1~2분) — 강의 하나에 몇 시간 걸려도 LMS 요청은 분당 1건 미만
export const VOD_POLL_INTERVAL_MS = 90_000;
// 강제 종료되면 status 가 playing 으로 남는다 — updatedAt 이 이보다 오래되면 읽는 쪽(#6)은 멈춘 것으로 본다
export const PLAYER_STATE_STALE_MS = 2 * VOD_POLL_INTERVAL_MS;
// 진도를 이만큼 연속으로 모르면(약 15분) 상태·로그로 알린다
export const VOD_UNKNOWN_WARN_POLLS = 10;
// 로그인 페이지가 200 으로 오면(리다이렉트 없이) 비밀번호 입력란으로 알아본다
export const LMS_LOGIN_FORM_SELECTOR = 'input[type="password"]';
// 진도 페이지(user_progress.php)의 진도 표
export const VOD_PROGRESS_TABLE_SELECTOR = '.user_progress';
// shortcut: 사용자 폴더 설치(%LOCALAPPDATA%) 브라우저는 못 찾는다, 요청이 있으면 cmd.exe /c echo %LOCALAPPDATA% 로 해석한다
export const WSL_PROGRAM_FILES = ['/mnt/c/Program Files', '/mnt/c/Program Files (x86)'];
