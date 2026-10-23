import { McpServer } from '@modelcontextprotocol/server';

// 서버 인스턴스 생성 — stdio 연결과 분리해 테스트에서 직접 쓸 수 있게 한다
export function createServer(): McpServer {
  return new McpServer({ name: 'dotbugi-mcp', version: '0.1.0' });
}
