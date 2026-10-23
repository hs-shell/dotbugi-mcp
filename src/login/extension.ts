import { CONNECT_HASH_KEY, DOTBUGI_EXTENSION_IDS, LMS_HOME_PATH, LMS_ORIGIN, LOGIN_TIMEOUT_MS } from '../constants.js';
import { log } from '../log.js';
import { openUrl } from '../platform.js';
import { startCallbackServer } from './callback-server.js';
import { codeFingerprint } from './fingerprint.js';

const ALLOWED_ORIGINS = DOTBUGI_EXTENSION_IDS.map((id) => `chrome-extension://${id}`);

// 기본 방식: 평소 브라우저의 LMS 로그인 상태를 dotbugi 확장(hs-shell/dotbugi#167)이 localhost 로 넘겨준다
export async function loginWithExtension(): Promise<string> {
  const server = await startCallbackServer(ALLOWED_ORIGINS, LOGIN_TIMEOUT_MS);
  // 포트·코드는 URL 해시에만 담는다 (서버로 전송되지 않고, 확장이 읽은 뒤 주소창에서 지운다)
  const url = `${LMS_ORIGIN}${LMS_HOME_PATH}#${CONNECT_HASH_KEY}=${server.port}.${server.code}`;
  try {
    await openUrl(url);
  } catch (err) {
    server.close();
    throw err;
  }
  log('브라우저에서 LMS에 로그인한 뒤, dotbugi 확장의 연결 창에서 승인하세요. (5분 제한)');
  log(`연결 창에 표시된 확인 코드가 ${codeFingerprint(server.code)} 인지 확인한 뒤 [연결]을 누르세요.`);
  log('dotbugi 확장이 없다면 Ctrl+C 로 중단하고 dotbugi-mcp login --browser 를 사용하세요.');
  return server.session;
}
