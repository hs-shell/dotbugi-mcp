import type { Readable, Writable } from 'node:stream';
import { createFrameDecoder, encodeFrame } from './cdp-frame.js';

export interface CdpClient {
  send(method: string): Promise<unknown>;
}

interface Pending {
  resolve(result: unknown): void;
  reject(err: Error): void;
  timer: NodeJS.Timeout;
}

// 브라우저 대상 세션(sessionId 없음)에 CDP 명령을 보낸다.
// 호출마다 시간 제한을 두고, 파이프가 닫히면 대기 중인 호출을 모두 실패시켜 멈추지 않게 한다.
// 응답 본문(쿠키 등)은 오류 메시지에 넣지 않는다
export function createCdpClient(write: Writable, read: Readable, timeoutMs: number): CdpClient {
  const pending = new Map<number, Pending>();
  let nextId = 0;
  let closed = false;

  const settle = (id: number, fn: (p: Pending) => void) => {
    const p = pending.get(id);
    if (!p) return;
    pending.delete(id);
    clearTimeout(p.timer);
    fn(p);
  };

  read.on(
    'data',
    createFrameDecoder((raw) => {
      let msg: { id?: number; result?: unknown; error?: unknown };
      try {
        msg = JSON.parse(raw) as typeof msg;
      } catch {
        return;
      }
      if (typeof msg.id !== 'number') return;
      settle(msg.id, (p) => (msg.error ? p.reject(new Error('CDP 명령이 실패했습니다.')) : p.resolve(msg.result)));
    })
  );

  const onClose = () => {
    closed = true;
    for (const id of [...pending.keys()]) settle(id, (p) => p.reject(new Error('브라우저와의 연결이 끊겼습니다.')));
  };
  read.once('end', onClose).once('close', onClose).on('error', onClose);
  write.once('close', onClose).on('error', onClose);

  return {
    send(method) {
      if (closed) return Promise.reject(new Error('브라우저와의 연결이 끊겼습니다.'));
      const id = ++nextId;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => settle(id, (p) => p.reject(new Error(`CDP ${method} 응답이 없습니다.`))),
          timeoutMs
        );
        pending.set(id, { resolve, reject, timer });
        write.write(encodeFrame({ id, method }));
      });
    },
  };
}
