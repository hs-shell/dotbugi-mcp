import { redact } from './redact.js';

// stdout 은 MCP 프로토콜 전용이므로 안내·로그는 항상 stderr 로, 마스킹을 거쳐 쓴다
export function log(message: string): void {
  process.stderr.write(`${redact(message)}\n`);
}
