import { isAlive } from '../player/lock.js';
import { readTranscribeQueue } from '../transcribe/queue.js';
import { readTranscribeState } from '../transcribe/state.js';
import { renderTranscribeStatusLine } from '../transcribe/status-line.js';

// Claude Code 상태 표시줄용 — 자주 실행되므로 상태 파일만 읽는다 (네트워크·키체인·stdin 없음). 실패해도 조용히 빈 줄
export function statusline(): void {
  try {
    const line = renderTranscribeStatusLine(readTranscribeState(), readTranscribeQueue(), Date.now(), isAlive);
    if (line) process.stdout.write(`${line}\n`);
  } catch {
    // 상태 표시줄을 깨뜨리지 않는다
  }
}
