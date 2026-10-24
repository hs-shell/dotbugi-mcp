import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { verifySession } from '../lms.js';
import { log } from '../log.js';
import { startExtensionLogin } from '../login/extension.js';
import { assertKeychain, verifyAndSave } from '../login/save.js';
import { redact } from '../redact.js';
import { readSession } from '../session.js';

// 진행 중인 연결의 확인 코드. 서버 프로세스당 하나만 연다 (다시 불러도 새 콜백 서버를 띄우지 않게)
let pending: Promise<string> | null = null;
// 직전 백그라운드 시도의 실패 이유. 다음 호출 응답에 한 번 보여 준다 (stderr 로그는 모델·사용자에게 안 보이므로)
let lastFailure: string | null = null;

// 저장된 세션이 지금도 로그인 상태인지. 형식이 깨진 값은 새로 로그인하면 덮어쓰므로 없는 것으로 본다
async function hasValidSession(): Promise<boolean> {
  const stored = await readSession().catch(() => null);
  return stored !== null && (await verifySession(stored.session));
}

async function begin(): Promise<string> {
  try {
    const { fingerprint, session } = await startExtensionLogin();
    // 승인 대기·확인·저장은 도구 응답 뒤에도 이어진다. 실패는 여기서 삼켜 처리되지 않은 rejection 으로 서버가 죽지 않게 한다
    void session
      .then((s) => verifyAndSave(s, 'extension'))
      .then(
        () => log('로그인 완료. 세션을 OS 키체인에 저장했습니다.'),
        (err: unknown) => {
          const message = err instanceof Error ? err.message : String(err);
          lastFailure = redact(message);
          log(message);
        }
      )
      .finally(() => (pending = null));
    return fingerprint;
  } catch (err) {
    pending = null;
    throw err;
  }
}

const guide = (fingerprint: string) =>
  [
    '브라우저에서 LMS에 로그인한 뒤, dotbugi 확장의 연결 창에서 승인하세요. (5분 제한)',
    `연결 창에 표시된 확인 코드가 ${fingerprint} 인지 확인한 뒤 [연결]을 누르세요. 다르면 누르지 마세요.`,
    '승인 후 login 을 다시 호출하면 로그인 여부를 확인할 수 있습니다.',
    'dotbugi 확장이 없다면 터미널에서 dotbugi-mcp login --browser 를 사용하세요.',
  ].join('\n');

export function registerLogin(server: McpServer): void {
  server.registerTool(
    'login',
    {
      title: 'LMS 로그인',
      description:
        '기본 브라우저로 LMS 를 열고 dotbugi 확장 연결로 세션을 받아 OS 키체인에 저장한다. ' +
        '승인을 기다리지 않고 확인 코드(XXX-XXX)와 안내를 바로 돌려주므로 사용자에게 그대로 전달한다. ' +
        '이미 로그인돼 있으면 그렇다고만 알린다.',
      inputSchema: z.object({}),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async () => {
      try {
        if (pending) return text(`로그인 진행 중입니다.\n${guide(await pending)}`);
        const failure = lastFailure ? `직전 로그인 실패: ${lastFailure}\n` : '';
        lastFailure = null;
        await assertKeychain();
        if (await hasValidSession()) return text(`${failure}이미 로그인되어 있습니다. 저장된 LMS 세션이 유효합니다.`);
        // 위의 await 사이에 다른 호출이 먼저 시작했을 수 있다
        const started = !pending;
        pending ??= begin();
        const fingerprint = await pending;
        return text(`${failure}${started ? '로그인을 시작했습니다.' : '로그인 진행 중입니다.'}\n${guide(fingerprint)}`);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { content: [{ type: 'text', text: redact(message) }], isError: true };
      }
    }
  );
}

function text(t: string) {
  return { content: [{ type: 'text' as const, text: t }] };
}
