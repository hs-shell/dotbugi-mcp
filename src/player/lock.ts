import { readFile, unlink, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { ensurePrivateDir } from './state.js';

export const isAlive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: 살아 있지만 신호 권한이 없다
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
};

// play 를 하나만 돌린다 (두 개면 같은 강의 창을 겹쳐 열고 상태 파일을 번갈아 덮는다). 해제 함수를 돌려준다
// shortcut: 죽은 잠금을 두 프로세스가 동시에 넘겨받으면 둘 다 실행될 수 있다, 문제가 되면 rename 기반 교체로 바꾼다
export async function acquireLock(
  file: string,
  busyMessage = '이미 play 가 실행 중입니다. 그 터미널에서 Ctrl+C 로 멈춘 뒤 다시 실행하세요.'
): Promise<() => Promise<void>> {
  await ensurePrivateDir(dirname(file));
  for (let attempt = 0; ; attempt++) {
    try {
      await writeFile(file, String(process.pid), { flag: 'wx', mode: 0o600 });
      return () => unlink(file).catch(() => {});
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    }
    const pid = Number((await readFile(file, 'utf8').catch(() => '')).trim());
    if ((Number.isInteger(pid) && pid > 0 && isAlive(pid)) || attempt > 0) throw new Error(busyMessage);
    // 강제 종료로 남은 잠금 — 넘겨받는다
    await unlink(file).catch(() => {});
  }
}
