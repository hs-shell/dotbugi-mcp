#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { login } from './commands/login.js';
import { logout } from './commands/logout.js';
import { log } from './log.js';
import { createServer } from './server.js';

const USAGE = `사용법:
  dotbugi-mcp                  MCP 서버 실행 (stdio)
  dotbugi-mcp login            dotbugi 확장으로 LMS 세션 연결
  dotbugi-mcp login --browser  임시 브라우저 창에서 직접 로그인
  dotbugi-mcp logout           저장된 세션 삭제`;

async function main(): Promise<void> {
  const { positionals, values } = parseArgs({ allowPositionals: true, options: { browser: { type: 'boolean' } } });
  const [command, ...rest] = positionals;
  if (rest.length > 0 || (values.browser && command !== 'login')) throw new Error(USAGE);
  // stdout 은 MCP 프로토콜 전용 — 로그는 반드시 stderr 로
  if (command === undefined) return void serveStdio(createServer);
  if (command === 'login') return login(values.browser ? 'browser' : 'extension');
  if (command === 'logout') return logout();
  throw new Error(USAGE);
}

main().catch((err: unknown) => {
  log(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
