import { CONNECT_HASH_KEY, DOTBUGI_EXTENSION_IDS, LMS_HOME_PATH, LMS_ORIGIN, LOGIN_TIMEOUT_MS } from '../constants.js';
import { log } from '../log.js';
import { openUrl } from '../platform.js';
import { startCallbackServer } from './callback-server.js';
import { codeFingerprint } from './fingerprint.js';

const ALLOWED_ORIGINS = DOTBUGI_EXTENSION_IDS.map((id) => `chrome-extension://${id}`);

export interface ExtensionLogin {
  // 확장 연결 창과 맞춰 볼 확인 코드 (비밀 아님)
  fingerprint: string;
  // 승인되면 세션, 시간 초과·잘못된 요청이면 reject (콜백 서버는 어느 쪽이든 스스로 닫힌다)
  session: Promise<string>;
}

// 기본 방식: 평소 브라우저의 LMS 로그인 상태를 dotbugi 확장(hs-shell/dotbugi#167)이 localhost 로 넘겨준다.
// 브라우저를 연 뒤 바로 돌아온다 — login 도구가 승인을 기다리지 않고 확인 코드부터 돌려줄 수 있게
export async function startExtensionLogin(): Promise<ExtensionLogin> {
  const server = await startCallbackServer(ALLOWED_ORIGINS, LOGIN_TIMEOUT_MS);
  // 브라우저를 여는 사이 잘못된 요청이 오면 rejection 이 처리되지 않아 프로세스가 죽는다. 실제 처리는 호출한 쪽이 한다
  server.session.catch(() => {});
  // 포트·코드는 URL 해시에만 담는다 (서버로 전송되지 않고, 확장이 읽은 뒤 주소창에서 지운다)
  const url = `${LMS_ORIGIN}${LMS_HOME_PATH}#${CONNECT_HASH_KEY}=${server.port}.${server.code}`;
  try {
    await openUrl(url);
  } catch (err) {
    server.close();
    throw err;
  }
  return { fingerprint: codeFingerprint(server.code), session: server.session };
}

// CLI 용: 안내를 출력하고 승인까지 기다린다
export async function loginWithExtension(): Promise<string> {
  const { fingerprint, session } = await startExtensionLogin();
  log('브라우저에서 LMS에 로그인한 뒤, dotbugi 확장의 연결 창에서 승인하세요. (5분 제한)');
  log(`연결 창에 표시된 확인 코드가 ${fingerprint} 인지 확인한 뒤 [연결]을 누르세요.`);
  log('dotbugi 확장이 없다면 Ctrl+C 로 중단하고 dotbugi-mcp login --browser 를 사용하세요.');
  return session;
}
