import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  CALLBACK_HOST,
  CALLBACK_MAX_BODY_BYTES,
  CALLBACK_MAX_FAILURES,
  CALLBACK_PATH,
  SESSION_PATTERN,
} from '../constants.js';

export interface CallbackServer {
  port: number;
  code: string;
  // 유효한 세션을 한 번 받으면 resolve, 시간 초과 시 reject
  session: Promise<string>;
  close(): void;
}

// dotbugi 확장이 보내는 { code, session } 을 127.0.0.1 에서 한 번만 받는다.
// 확장 출처(Origin) + 일회용 코드 둘 다 맞아야 수락한다. 잘못된 요청은 거부만 하고 시간 초과까지 계속 기다린다. 거부 사유는 응답 코드로만 알린다(값은 기록하지 않음)
export function startCallbackServer(allowedOrigins: readonly string[], timeoutMs: number): Promise<CallbackServer> {
  const code = randomBytes(24).toString('base64url');
  let accept!: (session: string) => void;
  let fail!: (err: Error) => void;
  const session = new Promise<string>((res, rej) => ((accept = res), (fail = rej)));
  let done = false;
  let failures = 0;

  const server = createServer((req, res) => {
    const origin = req.headers.origin;
    if (done || req.method !== 'POST' || req.url !== CALLBACK_PATH) return void res.writeHead(404).end();
    // 잘못된 요청에 닫으면 포트가 풀려 다른 로컬 사용자가 선점할 수 있다. 그래서 거부만 하고 계속 붙들고 있는다
    const reject = (status: number) => {
      failures++;
      res.writeHead(status).end();
    };
    // 192비트 코드라 추측은 사실상 불가능하지만, 실패가 쌓이면 이후 요청은 모두 거부한다(포트는 시간 초과까지 유지)
    if (failures >= CALLBACK_MAX_FAILURES) return void res.writeHead(429).end();
    // DNS 리바인딩 등으로 다른 이름을 거쳐 온 요청은 받지 않는다
    if (req.headers.host !== `${CALLBACK_HOST}:${port()}`) return reject(421);
    if (!origin || !allowedOrigins.includes(origin)) return reject(403);
    if (Number(req.headers['content-length'] ?? 0) > CALLBACK_MAX_BODY_BYTES) return reject(413);
    readBody(req, res, reject, (body) => {
      // 동시에 들어온 다른 유효 요청이 먼저 수락됐으면 받지 않는다
      if (done) return void res.writeHead(404).end();
      const msg = parseJson(body);
      if (!msg) return reject(400);
      if (!sameCode(String(msg.code), code)) return reject(403);
      if (!SESSION_PATTERN.test(String(msg.session))) return reject(400);
      // 모든 검사를 통과한 뒤에만 일회성으로 닫는다
      done = true;
      res.writeHead(200, { 'Access-Control-Allow-Origin': origin }).end('ok', close);
      accept(String(msg.session));
    });
  });
  const port = () => (server.address() as AddressInfo).port;

  const timer = setTimeout(() => {
    close();
    fail(new Error('시간이 초과되었습니다. login 도구로 다시 시도하세요.'));
  }, timeoutMs);
  function close() {
    clearTimeout(timer);
    server.close();
    server.closeAllConnections();
  }

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, CALLBACK_HOST, () => {
      resolve({ port: port(), code, session, close });
    });
  });
}

// 크기 제한을 넘으면 413 으로 끊는다 (Content-Length 없이 흘려보내는 경우 대비)
function readBody(
  req: IncomingMessage,
  res: ServerResponse,
  reject: (status: number) => void,
  onBody: (body: string) => void
) {
  const chunks: Buffer[] = [];
  let size = 0;
  req.on('data', (chunk: Buffer) => {
    if (size > CALLBACK_MAX_BODY_BYTES) return;
    size += chunk.length;
    if (size > CALLBACK_MAX_BODY_BYTES) {
      res.setHeader('connection', 'close');
      reject(413);
      req.destroy();
      return;
    }
    chunks.push(chunk);
  });
  req.on('end', () => {
    if (size <= CALLBACK_MAX_BODY_BYTES) onBody(Buffer.concat(chunks).toString('utf8'));
  });
}

function parseJson(body: string): Record<string, unknown> | null {
  try {
    const v: unknown = JSON.parse(body);
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

// 해시를 비교해 길이 차이로도 분기하지 않는 상수 시간 비교
function sameCode(a: string, b: string): boolean {
  const digest = (s: string) => createHash('sha256').update(s).digest();
  return timingSafeEqual(digest(a), digest(b));
}
