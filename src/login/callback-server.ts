import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { CALLBACK_HOST, CALLBACK_MAX_BODY_BYTES, CALLBACK_PATH, SESSION_PATTERN } from '../constants.js';

export interface CallbackServer {
  port: number;
  code: string;
  // 유효한 세션을 한 번 받으면 resolve, 시간 초과 시 reject
  session: Promise<string>;
  close(): void;
}

// dotbugi 확장이 보내는 { code, session } 을 127.0.0.1 에서 한 번만 받는다.
// 확장 출처(Origin) + 일회용 코드 둘 다 맞아야 수락한다. 거부 사유는 응답 코드로만 알린다(값은 기록하지 않음)
export function startCallbackServer(allowedOrigins: readonly string[], timeoutMs: number): Promise<CallbackServer> {
  const code = randomBytes(24).toString('base64url');
  let accept!: (session: string) => void;
  let fail!: (err: Error) => void;
  const session = new Promise<string>((res, rej) => ((accept = res), (fail = rej)));
  let done = false;

  const server = createServer((req, res) => {
    const origin = req.headers.origin;
    if (done || req.method !== 'POST' || req.url !== CALLBACK_PATH) return void res.writeHead(404).end();
    if (!origin || !allowedOrigins.includes(origin)) return void res.writeHead(403).end();
    if (Number(req.headers['content-length'] ?? 0) > CALLBACK_MAX_BODY_BYTES) return void res.writeHead(413).end();
    readBody(req, res, (body) => {
      const msg = parseJson(body);
      if (!msg) return void res.writeHead(400).end();
      if (!sameCode(String(msg.code), code)) return void res.writeHead(403).end();
      if (!SESSION_PATTERN.test(String(msg.session))) return void res.writeHead(400).end();
      done = true;
      res.writeHead(200, { 'Access-Control-Allow-Origin': origin }).end('ok', close);
      accept(String(msg.session));
    });
  });

  const timer = setTimeout(() => {
    close();
    fail(new Error('시간이 초과되었습니다. dotbugi-mcp login 을 다시 실행하세요.'));
  }, timeoutMs);
  function close() {
    clearTimeout(timer);
    server.close();
    server.closeAllConnections();
  }

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, CALLBACK_HOST, () => {
      resolve({ port: (server.address() as AddressInfo).port, code, session, close });
    });
  });
}

// 크기 제한을 넘으면 413 으로 끊는다 (Content-Length 없이 흘려보내는 경우 대비)
function readBody(req: IncomingMessage, res: ServerResponse, onBody: (body: string) => void) {
  const chunks: Buffer[] = [];
  let size = 0;
  req.on('data', (chunk: Buffer) => {
    size += chunk.length;
    if (size > CALLBACK_MAX_BODY_BYTES) {
      res.writeHead(413, { connection: 'close' }).end();
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
