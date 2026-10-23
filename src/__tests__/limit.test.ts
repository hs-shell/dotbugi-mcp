import { describe, expect, it } from 'vitest';
import { createLimiter } from '../limit.js';

describe('createLimiter', () => {
  it('자리가 비는 순간 같은 틱에 끼어든 호출이 있어도 max 를 넘지 않는다', async () => {
    const limit = createLimiter(1);
    let active = 0;
    let peak = 0;
    const tracked = (wait: Promise<void>) => async () => {
      peak = Math.max(peak, ++active);
      await wait;
      active--;
    };
    let open!: () => void;
    const gate = new Promise<void>((resolve) => (open = resolve));
    const running = tracked(gate)();
    const first = limit(() => running);
    const waiter = limit(tracked(Promise.resolve()));
    // 첫 작업과 같은 promise 에 이어 붙여, 자리가 풀린 직후(대기자가 깨어나기 전) 같은 틱에 새 호출을 넣는다
    const sameTick = running.then(() => limit(tracked(Promise.resolve())));
    open();
    await Promise.all([first, waiter, sameTick]);
    expect(peak).toBe(1);
  });

  it('여러 작업을 max 개씩 모두 실행한다', async () => {
    const limit = createLimiter(2);
    const results = await Promise.all([1, 2, 3, 4, 5].map((n) => limit(async () => n * 2)));
    expect(results).toEqual([2, 4, 6, 8, 10]);
  });
});
