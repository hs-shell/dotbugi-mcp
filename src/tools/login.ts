import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { verifySession } from '../lms.js';
import { log } from '../log.js';
import { findLoginBrowser, loginWithBrowser } from '../login/browser.js';
import { startExtensionLogin } from '../login/extension.js';
import { assertKeychain, verifyAndSave } from '../login/save.js';
import { redact } from '../redact.js';
import { isWsl } from '../platform.js';
import { readSession, type LoginMethod } from '../session.js';

// 진행 중인 로그인의 안내문. 방식과 관계없이 서버 프로세스당 하나만 연다 (다시 불러도 콜백 서버·창을 새로 띄우지 않게)
let pending: Promise<string> | null = null;
// 직전 백그라운드 시도의 실패 이유. 다음 호출 응답에 한 번 보여 준다 (stderr 로그는 모델·사용자에게 안 보이므로)
let lastFailure: string | null = null;
// 로그인 시도 세대. logout 이 대기 중인 시도를 취소하면 올려서, 늦게 도착한 세션을 저장하지 않게 한다
let generation = 0;

// 대기 중인 로그인을 취소한다. 취소할 것이 있었는지 돌려준다 (창·콜백 서버는 각자 시간 제한으로 닫힌다)
export function cancelPendingLogin(): boolean {
  if (!pending) return false;
  generation++;
  pending = null;
  return true;
}

// 저장된 세션이 지금도 로그인 상태인지. 형식이 깨진 값은 새로 로그인하면 덮어쓰므로 없는 것으로 본다
async function hasValidSession(): Promise<boolean> {
  const stored = await readSession().catch(() => null);
  return stored !== null && (await verifySession(stored.session));
}

async function begin(method: LoginMethod): Promise<string> {
  const gen = generation;
  try {
    let session: Promise<string>;
    let instructions: string;
    if (method === 'browser') {
      // 창에서 로그인할 때까지(최대 5분) 기다리므로 확장 방식처럼 응답 뒤에 이어 간다. 임시 프로필 정리는 loginWithBrowser 의 finally 가 맡는다
      session = loginWithBrowser();
      instructions = BROWSER_GUIDE;
    } else {
      const started = await startExtensionLogin();
      session = started.session;
      instructions = guide(started.fingerprint);
    }
    // 승인 대기·확인·저장은 도구 응답 뒤에도 이어진다. 실패는 여기서 삼켜 처리되지 않은 rejection 으로 서버가 죽지 않게 한다
    void session
      .then(async (s) => {
        if (gen !== generation) return log('취소된 로그인이라 받은 세션을 저장하지 않았습니다.');
        await verifyAndSave(s, method);
        log('로그인 완료. 세션을 OS 키체인에 저장했습니다.');
      })
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        // 취소된 시도의 실패는 다음 응답에 보여 주지 않는다
        if (gen === generation) lastFailure = redact(message);
        log(message);
      })
      // 취소 뒤 새로 시작한 시도의 pending 을 지우지 않는다
      .finally(() => gen === generation && (pending = null));
    return instructions;
  } catch (err) {
    if (gen === generation) pending = null;
    throw err;
  }
}

const guide = (fingerprint: string) =>
  [
    '브라우저에서 LMS에 로그인한 뒤, dotbugi 확장의 연결 창에서 승인하세요. (5분 제한)',
    `연결 창에 표시된 확인 코드가 ${fingerprint} 인지 확인한 뒤 [연결]을 누르세요. 다르면 누르지 마세요.`,
    '승인 후 login 을 다시 호출하면 로그인 여부를 확인할 수 있습니다.',
    'dotbugi 확장이 없다면 login 을 method=browser 로 호출하세요. (WSL 제외)',
  ].join('\n');

const BROWSER_GUIDE = [
  '임시 브라우저 창을 열었습니다. 창의 주소가 LMS 인지 확인한 뒤 로그인하세요. (5분 제한)',
  '열린 창에서 LMS 로그인하면 창이 자동으로 닫히고 세션이 OS 키체인에 저장됩니다.',
  '로그인 후 login 을 다시 호출하면 로그인 여부를 확인할 수 있습니다.',
].join('\n');

export function registerLogin(server: McpServer): void {
  server.registerTool(
    'login',
    {
      title: 'LMS 로그인',
      description:
        '한성대 LMS(learn.hansung.ac.kr) 세션을 받아 OS 키체인에 저장한다. method=extension(기본)은 기본 브라우저로 LMS 를 열고 dotbugi 확장 연결로, ' +
        'method=browser 는 임시 프로필 브라우저 창에서 사용자가 직접 로그인한다 (확장이 없을 때, WSL 미지원). ' +
        '로그인을 기다리지 않고 안내(extension 은 확인 코드 XXX-XXX 포함)를 바로 돌려주므로 사용자에게 그대로 전달한다. ' +
        '이미 로그인돼 있으면 그렇다고만 알린다.',
      inputSchema: z.object({
        method: z
          .enum(['extension', 'browser'])
          .default('extension')
          .describe('extension: dotbugi 확장 연결(기본) / browser: 임시 브라우저 창에서 직접 로그인'),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ method }) => {
      try {
        if (pending) return text(`로그인 진행 중입니다.\n${await pending}`);
        const failure = lastFailure ? `직전 로그인 실패: ${lastFailure}\n` : '';
        lastFailure = null;
        await assertKeychain();
        if (await hasValidSession()) return text(`${failure}이미 로그인되어 있습니다. 저장된 LMS 세션이 유효합니다.`);
        if (method === 'browser') {
          // 창을 띄울 수 없는 환경은 백그라운드로 넘기기 전에 바로 알린다
          try {
            findLoginBrowser();
          } catch (err) {
            if (!isWsl()) throw err;
            const message = err instanceof Error ? err.message : String(err);
            throw new Error(`${message}\nlogin 을 method=extension(기본)으로 다시 호출하세요.`);
          }
        }
        // 위의 await 사이에 다른 호출이 먼저 시작했을 수 있다
        const started = !pending;
        pending ??= begin(method);
        const instructions = await pending;
        return text(`${failure}${started ? '로그인을 시작했습니다.' : '로그인 진행 중입니다.'}\n${instructions}`);
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
