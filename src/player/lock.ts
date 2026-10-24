import { randomUUID } from 'node:crypto';
import { link, readFile, stat, unlink, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { ensurePrivateDir, replaceFile } from './state.js';

export const isAlive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: 살아 있지만 신호 권한이 없다
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
};

const readPid = async (file: string) => Number((await readFile(file, 'utf8').catch(() => '')).trim());
const isHeld = (pid: number) => Number.isInteger(pid) && pid > 0 && isAlive(pid);

// 해제는 잠금이 아직 내 것일 때만 지운다 — 그 사이 넘겨준(작업 프로세스로 바꾼) 잠금을 지우지 않게
const releaser = (file: string) => async () => {
  if ((await readPid(file)) === process.pid) await unlink(file).catch(() => {});
};

const TAKEOVER_STALE_MS = 10_000;

// 죽은 잠금 교체는 표시 파일(wx)을 잡은 프로세스 하나만 한다. 잡은 뒤 다시 읽어 아직 죽은 잠금일 때만 rename 으로 덮는다
// (unlink 뒤 새로 만들면, 먼저 읽어 둔 죽은 pid 를 근거로 다른 프로세스가 방금 넘겨받은 잠금까지 지울 수 있다)
async function takeOver(file: string, tmp: string): Promise<boolean> {
  const guard = `${file}.takeover`;
  try {
    await writeFile(guard, String(process.pid), { flag: 'wx', mode: 0o600 });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    // 교체 도중(수 ms) 죽은 프로세스가 남긴 표시만 치운다
    // shortcut: 낡은 표시를 두 프로세스가 동시에 치우면 교체가 겹칠 수 있다(교체 중 강제 종료가 겹쳐야 함), 문제가 되면 표시도 pid 로 검사한다
    const st = await stat(guard).catch(() => null);
    if (st && Date.now() - st.mtimeMs > TAKEOVER_STALE_MS) await unlink(guard).catch(() => {});
    return false;
  }
  try {
    const content = await readFile(file, 'utf8').catch(() => null);
    // 그 사이 다른 프로세스가 넘겨받았거나 해제했으면 처음부터 다시
    if (content === null || isHeld(Number(content.trim()))) return false;
    await replaceFile(tmp, file);
    return true;
  } finally {
    await unlink(guard).catch(() => {});
  }
}

// 같은 작업(동기화·받아쓰기·ASR 설치)을 한 번에 하나만 돌린다. 해제 함수를 돌려준다
export async function acquireLock(file: string, busyMessage = '이미 실행 중입니다.'): Promise<() => Promise<void>> {
  await ensurePrivateDir(dirname(file));
  const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(tmp, String(process.pid), { flag: 'wx', mode: 0o600 });
  try {
    for (let attempt = 0; attempt < 3; attempt++) {
      // link: 다 쓴 파일이 한 번에 나타난다 — 쓰는 중인 빈 잠금을 다른 프로세스가 죽은 것으로 오해하지 않게. 있으면 EEXIST
      try {
        await link(tmp, file);
        return releaser(file);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      }
      if (isHeld(await readPid(file))) throw new Error(busyMessage);
      // 강제 종료로 남은 잠금 — 넘겨받는다
      if (await takeOver(file, tmp)) return releaser(file);
    }
    throw new Error(busyMessage);
  } finally {
    await unlink(tmp).catch(() => {});
  }
}

// 다른 프로세스가 잡아 넘겨준 잠금(파일에 내 pid)을 이어받는다. 넘겨받기 전에 뜰 수 있어 잠시 기다린다
export async function adoptLock(file: string, timeoutMs = 5000): Promise<() => Promise<void>> {
  for (const end = Date.now() + timeoutMs; ;) {
    if ((await readFile(file, 'utf8').catch(() => '')).trim() === String(process.pid)) return releaser(file);
    if (Date.now() > end) throw new Error('넘겨받을 작업 잠금이 없습니다.');
    await new Promise((r) => setTimeout(r, 50));
  }
}
