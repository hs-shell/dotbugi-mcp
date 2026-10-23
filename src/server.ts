import { createRequire } from 'node:module';
import { McpServer } from '@modelcontextprotocol/server';
import { registerGetAssignment } from './tools/get-assignment.js';
import { registerListTasks } from './tools/list-tasks.js';

// 버전은 package.json 단일 출처 (src/·dist/ 모두 한 단계 아래라 같은 상대 경로)
const { version } = createRequire(import.meta.url)('../package.json') as { version: string };

// 서버 인스턴스 생성 — stdio 연결과 분리해 테스트에서 직접 쓸 수 있게 한다
export function createServer(): McpServer {
  const server = new McpServer({ name: 'dotbugi-mcp', version });
  registerListTasks(server);
  registerGetAssignment(server);
  return server;
}
