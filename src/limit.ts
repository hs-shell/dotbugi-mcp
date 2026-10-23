// 동시에 실행되는 비동기 작업 수를 max 개로 제한한다
export function createLimiter(max: number): <T>(task: () => Promise<T>) => Promise<T> {
  let active = 0;
  const waiting: (() => void)[] = [];
  return async (task) => {
    // 대기자는 release 가 넘겨준 자리를 그대로 이어받는다 (active 를 줄였다 늘리면 그 사이 같은 틱 호출이 끼어든다)
    if (active >= max) await new Promise<void>((resolve) => waiting.push(resolve));
    else active++;
    try {
      return await task();
    } finally {
      const next = waiting.shift();
      if (next) next();
      else active--;
    }
  };
}
