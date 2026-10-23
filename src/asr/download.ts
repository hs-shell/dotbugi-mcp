import { createHash, type Hash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { open, rename, stat, unlink } from 'node:fs/promises';
import { isAllowedDownloadUrl } from './pins.js';

const MAX_REDIRECTS = 5;
const SHA256_HEX = /^[0-9a-f]{64}$/;

export function assertPinned(sha256: string, what: string): void {
  if (!SHA256_HEX.test(sha256))
    throw new Error(`${what} 의 sha256 이 아직 코드에 고정되지 않아 설치할 수 없습니다 (src/asr/pins.ts 참고).`);
}

async function hashInto(path: string, hash: Hash): Promise<void> {
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
}

// 없으면 null
export async function fileSha256(path: string): Promise<string | null> {
  const hash = createHash('sha256');
  try {
    await hashInto(path, hash);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
  return hash.digest('hex');
}

// 리다이렉트도 한 단계씩 직접 따라가며 매번 허용 호스트인지 확인한다
async function fetchAllowed(url: string, headers: Record<string, string>): Promise<Response> {
  let current = new URL(url);
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if (!isAllowedDownloadUrl(current)) throw new Error(`허용되지 않은 주소로는 받지 않습니다: ${current.origin}`);
    const res = await fetch(current, { headers, redirect: 'manual' });
    const location = res.headers.get('location');
    if (res.status < 300 || res.status >= 400 || !location) return res;
    await res.body?.cancel();
    current = new URL(location, current);
  }
  throw new Error('리다이렉트가 너무 많습니다.');
}

function progress(label: string, done: number, total: number): void {
  if (!process.stderr.isTTY || !total) return;
  process.stderr.write(
    `\r${label} ${Math.floor((done / total) * 100)}% (${(done / 1e6).toFixed(0)}/${(total / 1e6).toFixed(0)}MB)`
  );
}

// dest 가 이미 sha256 과 같으면 건너뛴다. 아니면 dest.part 에 이어 받아(중단돼도 다음 실행이 이어 받음)
// 전체 해시가 맞을 때만 dest 로 rename 한다. 틀리면 .part 를 지우고 실패
export async function download(url: string, dest: string, sha256: string, label: string): Promise<void> {
  assertPinned(sha256, label);
  if ((await fileSha256(dest)) === sha256) return;
  await unlink(dest).catch(() => {});
  const part = `${dest}.part`;
  const offset = await stat(part).then(
    (s) => s.size,
    () => 0
  );
  const res = await fetchAllowed(url, offset ? { range: `bytes=${offset}-` } : {});
  // 서버가 이어 받기에 응하지 않으면(200) 처음부터 다시 받는다
  const resumed = offset > 0 && res.status === 206 && res.headers.get('content-range')?.startsWith(`bytes ${offset}-`);
  if (!resumed && res.status !== 200) {
    await res.body?.cancel();
    // 이어 받기를 거절(416 등)하면 .part 를 버리고 처음부터 한 번 더
    if (offset) return unlink(part).then(() => download(url, dest, sha256, label));
    throw new Error(`${label} 을(를) 받지 못했습니다 (HTTP ${res.status}).`);
  }
  if (!res.body) throw new Error(`${label} 응답 본문이 없습니다.`);
  const hash = createHash('sha256');
  if (resumed) await hashInto(part, hash);
  let done = resumed ? offset : 0;
  const total = done + Number(res.headers.get('content-length') ?? 0);
  const file = await open(part, resumed ? 'a' : 'w', 0o600);
  try {
    for await (const chunk of res.body) {
      hash.update(chunk);
      await file.write(chunk);
      done += chunk.length;
      progress(label, done, total);
    }
  } finally {
    await file.close();
    if (process.stderr.isTTY && total) process.stderr.write('\n');
  }
  if (hash.digest('hex') !== sha256) {
    await unlink(part);
    throw new Error(`${label} 의 sha256 이 고정값과 달라 버렸습니다. 다시 시도해도 같으면 알려 주세요.`);
  }
  await rename(part, dest);
}
