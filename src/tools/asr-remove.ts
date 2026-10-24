import { existsSync } from 'node:fs';
import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { ASR_ROOT } from '../asr/runtime.js';
import { ASR_REMOVE_LOCKS, deleteAsrRoot } from '../commands/asr.js';
import { redact } from '../redact.js';
import { askerOf, confirmDestructive, confirmTokenInput, type Asker } from './confirm.js';

// 경로는 고정(ASR_ROOT) — 인자로 받지 않는다. root·locks 는 테스트용
export async function asrRemove(
  asker: Asker,
  confirmToken: string | undefined,
  root = ASR_ROOT,
  locks = ASR_REMOVE_LOCKS
): Promise<string> {
  if (!existsSync(root)) return '설치된 ASR 런타임이 없습니다.';
  const confirmed = await confirmDestructive(asker, {
    action: 'asr_remove',
    message:
      '로컬 음성 인식(ASR) 런타임 폴더를 통째로 삭제합니다 (모델·바이너리, 수백 MB~수 GB). 다시 쓰려면 asr_install 로 새로 받아야 합니다.',
    targets: [root],
    token: confirmToken,
  });
  if (!confirmed.ok) return confirmed.text;
  // 설치·받아쓰기 잠금은 deleteAsrRoot 가 잡는다 — 실행 중이면 승인했어도 거절
  await deleteAsrRoot(root, locks);
  return `삭제했습니다: ${root}`;
}

export function registerAsrRemove(server: McpServer): void {
  server.registerTool(
    'asr_remove',
    {
      title: 'ASR 런타임 삭제',
      description:
        `로컬 음성 인식 런타임(${ASR_ROOT})을 삭제한다. 사용자가 클라이언트 확인 창에서 직접 승인해야 지운다. ` +
        '설치·받아쓰기 작업이 실행 중이면 거절한다. 확인 창이 없는 클라이언트면 confirmToken 을 돌려준다 — 사용자 동의를 받은 뒤에만 그 토큰으로 다시 호출한다.',
      inputSchema: z.object({ confirmToken: confirmTokenInput }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    async ({ confirmToken }, ctx) => {
      try {
        return { content: [{ type: 'text', text: await asrRemove(askerOf(server, ctx), confirmToken) }] };
      } catch (err) {
        return {
          content: [{ type: 'text', text: redact(err instanceof Error ? err.message : String(err)) }],
          isError: true,
        };
      }
    }
  );
}
