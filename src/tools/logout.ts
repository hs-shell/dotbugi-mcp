import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { logout } from '../commands/logout.js';
import { redact } from '../redact.js';

export function registerLogout(server: McpServer): void {
  server.registerTool(
    'logout',
    {
      title: 'LMS 로그아웃',
      description:
        'OS 키체인에 저장된 LMS 세션을 삭제한다. method=browser 로 얻은 세션은 LMS 서버 세션도 종료한다 ' +
        '(확장 연결 세션은 평소 브라우저와 공유되므로 서버 로그아웃하지 않는다). 다시 쓰려면 login 을 호출한다.',
      inputSchema: z.object({}),
      // 세션을 지우지만 login 으로 되돌릴 수 있어 별도 확인(elicitation) 없이 destructiveHint 로만 알린다
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    async () => {
      try {
        const lines: string[] = [];
        await logout((message) => lines.push(message));
        return { content: [{ type: 'text' as const, text: redact(lines.join('\n')) }] };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { content: [{ type: 'text' as const, text: redact(message) }], isError: true };
      }
    }
  );
}
