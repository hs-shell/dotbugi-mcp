import { createHash, randomBytes } from 'node:crypto';
import {
  SdkError,
  SdkErrorCode,
  type ClientCapabilities,
  type ElicitRequestFormParams,
  type ElicitResult,
  type McpServer,
  type RequestOptions,
  type ServerContext,
} from '@modelcontextprotocol/server';
import * as z from 'zod/v4';

// 되돌릴 수 없는 동작 전에 "사용자"에게 묻는 창구. 모델이 아니라 사람이 클라이언트 화면에서 승인해야 한다
export interface Asker {
  caps: ClientCapabilities | undefined;
  elicit: (params: ElicitRequestFormParams, options?: RequestOptions) => Promise<ElicitResult>;
}

export const askerOf = (server: McpServer, ctx: ServerContext): Asker => ({
  // 2025 세대는 initialize 때 값, 2026-07-28 세대는 요청마다 채워진다 (SDK 설명)
  caps: server.server.getClientCapabilities(),
  // 클라이언트가 도구 호출을 취소하면 확인 대기도 바로 끝나 잡고 있던 잠금이 풀린다
  elicit: (params, options) => ctx.mcpReq.elicitInput(params, { ...options, signal: ctx.mcpReq.signal }),
});

export const confirmTokenInput = z
  .string()
  .max(128)
  .optional()
  .describe(
    '확인 창을 띄울 수 없는 클라이언트에서 첫 호출이 돌려준 일회용 확인 토큰. 사용자에게 목록을 보여주고 동의를 받은 뒤에만 넣는다'
  );

// 사람이 읽고 누르는 시간 — 기본 60초로는 부족하다
const ELICIT_TIMEOUT_MS = 10 * 60_000;
const TOKEN_TTL_MS = 5 * 60_000;
// 토큰 → 묶인 대상 집합의 지문. 서버 메모리에만 두고 한 번 쓰면(맞든 틀리든) 버린다
const tokens = new Map<string, { fingerprint: string; expires: number }>();

const fingerprintOf = (action: string, binding: string[]) =>
  createHash('sha256')
    .update(JSON.stringify([action, [...binding].sort()]))
    .digest('hex');

export interface ConfirmRequest {
  action: string;
  message: string;
  // 사용자에게 보여줄 대상 (경로 등)
  targets: string[];
  // 토큰을 묶을 대상의 정체 (경로+해시 등). 생략하면 targets
  binding?: string[];
  token?: string;
  // 기본은 삭제. 'change' 는 되돌릴 수 있는 설정 변경, 'move'·'relocate' 는 저장 위치 이동·변경(set_storage_dir) — 확인 창 문구만 다르다
  kind?: keyof typeof WORDS;
}
export type ConfirmOutcome = { ok: true } | { ok: false; text: string };

const WORDS = {
  delete: {
    label: '위 항목을 삭제합니다',
    warn: '\n\n되돌릴 수 없습니다.',
    none: '아무것도 지우지 않았습니다',
    agree: '삭제',
  },
  change: { label: '위와 같이 변경합니다', warn: '', none: '아무것도 바꾸지 않았습니다', agree: '변경' },
  move: { label: '위 항목을 옮깁니다', warn: '', none: '아무것도 옮기지 않았습니다', agree: '이동' },
  relocate: { label: '저장 위치를 바꿉니다', warn: '', none: '저장 위치를 바꾸지 않았습니다', agree: '저장 위치 변경' },
};

export async function confirmDestructive(asker: Asker, req: ConfirmRequest): Promise<ConfirmOutcome> {
  const w = WORDS[req.kind ?? 'delete'];
  const fingerprint = fingerprintOf(req.action, req.binding ?? req.targets);
  const list = req.targets.map((t) => `- ${t}`).join('\n');
  if (req.token !== undefined) {
    const saved = tokens.get(req.token);
    tokens.delete(req.token);
    if (saved && saved.expires > Date.now() && saved.fingerprint === fingerprint) return { ok: true };
    return {
      ok: false,
      text: `확인 토큰이 없거나 만료됐거나 다른 대상의 것입니다. ${w.none}. confirmToken 없이 다시 호출해 새 목록을 받으세요.`,
    };
  }
  if (asker.caps?.elicitation?.form) {
    const result = await asker
      .elicit(
        {
          mode: 'form',
          message: `${req.message}\n\n${list}${w.warn}`,
          requestedSchema: {
            type: 'object',
            properties: { confirm: { type: 'boolean', title: w.label, default: false } },
            required: ['confirm'],
          },
        },
        { timeout: ELICIT_TIMEOUT_MS }
      )
      .catch((err: unknown) => {
        // 2026-07-28 세대 요청은 서버→클라이언트 요청을 보내기 전에 SDK 가 막는다 — 확인 창 없음으로 보고 토큰 방식으로 넘어간다.
        // 보낸 뒤의 실패(취소·시간 초과 등)는 그대로 던진다 (사용자가 답하지 않은 것을 토큰으로 바꾸지 않게)
        if (err instanceof SdkError && err.code === SdkErrorCode.MethodNotSupportedByProtocolVersion) return null;
        throw err;
      });
    // 명시적 accept + confirm=true 만 승인. decline·cancel·체크 안 함은 모두 취소
    if (result?.action === 'accept' && result.content?.confirm === true) return { ok: true };
    if (result) return { ok: false, text: `사용자가 승인하지 않아 ${w.none}.` };
  }
  // 확인 창을 못 띄우는 클라이언트 — 목록과 일회용 토큰을 돌려주고 두 번째 호출에서만 지운다
  const now = Date.now();
  for (const [t, v] of tokens) if (v.expires <= now) tokens.delete(t);
  const token = randomBytes(32).toString('hex');
  tokens.set(token, { fingerprint, expires: now + TOKEN_TTL_MS });
  return {
    ok: false,
    text: [
      `${req.message} (아직 ${w.none})`,
      list,
      '',
      `이 클라이언트는 확인 창(elicitation)을 지원하지 않습니다. 위 목록을 사용자에게 그대로 보여주고, 사용자가 ${w.agree}에 동의한 경우에만`,
      `confirmToken: "${token}" 을 넣어 같은 인자로 다시 호출하세요. 토큰은 ${TOKEN_TTL_MS / 60_000}분 안에 한 번만, 이 목록에만 쓸 수 있습니다.`,
    ].join('\n'),
  };
}
