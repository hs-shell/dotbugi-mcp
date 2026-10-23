import {
  LMS_HOME_PATH,
  LMS_LOGOUT_PATH,
  LMS_ORIGIN,
  LMS_REQUEST_TIMEOUT_MS,
  LOGIN_URL_MARKER,
  SESSION_COOKIE,
  SESSKEY_PATTERN,
} from './constants.js';

export class SessionExpiredError extends Error {
  constructor() {
    super('LMS 세션이 만료되었습니다. 터미널에서 dotbugi-mcp login 을 다시 실행하세요.');
  }
}

// 세션 쿠키를 붙이는 유일한 경로. 출처가 정확히 LMS 가 아니면 보내지 않고, 리다이렉트는 따라가지 않는다
export async function lmsFetch(
  pathOrUrl: string,
  session: string,
  timeoutMs = LMS_REQUEST_TIMEOUT_MS
): Promise<Response> {
  const url = new URL(pathOrUrl, LMS_ORIGIN);
  if (url.origin !== LMS_ORIGIN || url.username || url.password)
    throw new Error('LMS 이외의 주소로는 요청하지 않습니다.');
  const res = await fetch(url, {
    headers: { cookie: `${SESSION_COOKIE}=${session}` },
    redirect: 'manual',
    signal: AbortSignal.timeout(timeoutMs),
  }).catch((err: unknown) => {
    // 원래 오류 대신 고정 문구만 던진다 (요청 정보가 섞이지 않게)
    if (err instanceof Error && err.name === 'TimeoutError')
      throw new Error(`LMS 가 ${timeoutMs / 1000}초 안에 응답하지 않았습니다.`);
    throw err;
  });
  const location = res.headers.get('location');
  if (res.status >= 300 && res.status < 400 && location && isLoginUrl(location)) throw new SessionExpiredError();
  return res;
}

function isLoginUrl(location: string): boolean {
  const url = new URL(location, LMS_ORIGIN);
  return url.origin === LMS_ORIGIN && url.pathname.includes(LOGIN_URL_MARKER);
}

// 로그인된 세션이면 /my/ 가 200 을 준다 (만료 시 로그인 페이지로 303)
export async function verifySession(session: string): Promise<boolean> {
  try {
    return (await lmsFetch(LMS_HOME_PATH, session)).status === 200;
  } catch (err) {
    if (err instanceof SessionExpiredError) return false;
    throw err;
  }
}

// 서버 세션 종료. logout.php 는 페이지에 박힌 sesskey 를 요구한다. 끝내 세션이 살아 있으면(또는 이미 만료) false
export async function lmsLogout(session: string): Promise<boolean> {
  let page: string;
  try {
    page = await (await lmsFetch(LMS_HOME_PATH, session)).text();
  } catch (err) {
    if (err instanceof SessionExpiredError) return false;
    throw err;
  }
  const sesskey = SESSKEY_PATTERN.exec(page)?.[1];
  if (!sesskey) return false;
  await lmsFetch(`${LMS_LOGOUT_PATH}?sesskey=${sesskey}`, session).catch((err: unknown) => {
    if (!(err instanceof SessionExpiredError)) throw err;
  });
  // sesskey 가 안 맞으면 Moodle 은 200 확인 페이지만 주고 세션을 유지하므로, 실제로 끊겼는지 다시 확인한다
  return !(await verifySession(session));
}
