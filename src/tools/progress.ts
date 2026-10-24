import type { ServerContext } from '@modelcontextprotocol/server';
import { PROGRESS_INTERVAL_MS } from '../constants.js';

export type Progress = (progress: number, message: string, total?: number) => void;

// 클라이언트가 progressToken 을 보냈을 때만 notifications/progress 를 보낸다 (없으면 undefined).
// 오래 걸리는 호출에서 클라이언트가 시간 초과로 끊지 않게 하려는 것 — 알림이 잦지 않게 간격을 두고, 마지막(progress === total)은 바로 보낸다.
// progress 는 호출마다 늘어나는 값으로 넘긴다 (명세: 알림마다 증가)
export function progressOf(ctx: ServerContext): Progress | undefined {
  const progressToken = ctx.mcpReq._meta?.progressToken;
  if (progressToken === undefined) return undefined;
  let last = -Infinity;
  return (progress, message, total) => {
    const now = Date.now();
    if (now - last < PROGRESS_INTERVAL_MS && progress !== total) return;
    last = now;
    // 알림 실패가 도구 결과를 망치지 않게 삼킨다
    ctx.mcpReq
      .notify({ method: 'notifications/progress', params: { progressToken, progress, total, message } })
      .catch(() => {});
  };
}
