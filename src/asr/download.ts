import { createHash, type Hash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { open, stat, unlink } from 'node:fs/promises';
import { replaceFile } from '../player/state.js';
import { isAllowedDownloadUrl, type FilePin } from './pins.js';

const MAX_REDIRECTS = 5;
// 이 시간 동안 응답·데이터가 한 바이트도 오지 않으면 끊는다 (.part 는 남아 다음 실행이 이어 받는다)
const STALL_TIMEOUT_MS = 60_000;
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
async function fetchAllowed(url: string, headers: Record<string, string>, signal: AbortSignal): Promise<Response> {
  let current = new URL(url);
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if (!isAllowedDownloadUrl(current)) throw new Error(`허용되지 않은 주소로는 받지 않습니다: ${current.origin}`);
    const res = await fetch(current, { headers, redirect: 'manual', signal });
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
// 전체 해시가 맞을 때만 dest 로 rename 한다. 틀리거나 크기 상한을 넘으면 .part 를 지우고 실패.
// onProgress 는 asr_install 작업 프로세스가 상태 파일에 진행률을 남기는 데 쓴다 (터미널이 없어 stderr 진행 표시를 못 본다)
export async function download(
  url: string,
  dest: string,
  pin: FilePin,
  label: string,
  onProgress?: (done: number, total: number) => void
): Promise<void> {
  assertPinned(pin.sha256, label);
  if ((await fileSha256(dest)) === pin.sha256) return;
  await unlink(dest).catch(() => {});
  const part = `${dest}.part`;
  const offset = await stat(part).then(
    (s) => s.size,
    () => 0
  );
  if (offset > pin.maxBytes) await unlink(part);
  const from = offset > pin.maxBytes ? 0 : offset;
  const stall = new AbortController();
  let timer = setTimeout(() => stall.abort(), STALL_TIMEOUT_MS);
  const alive = () => {
    clearTimeout(timer);
    timer = setTimeout(() => stall.abort(), STALL_TIMEOUT_MS);
  };
  try {
    const res = await fetchAllowed(url, from ? { range: `bytes=${from}-` } : {}, stall.signal);
    // 서버가 이어 받기에 응하지 않으면(200) 처음부터 다시 받는다
    const resumed = from > 0 && res.status === 206 && res.headers.get('content-range')?.startsWith(`bytes ${from}-`);
    if (!resumed && res.status !== 200) {
      await res.body?.cancel();
      // 이어 받기를 거절(416 등)하면 .part 를 버리고 처음부터 한 번 더
      if (from) return await unlink(part).then(() => download(url, dest, pin, label, onProgress));
      throw new Error(`${label} 을(를) 받지 못했습니다 (HTTP ${res.status}).`);
    }
    if (!res.body) throw new Error(`${label} 응답 본문이 없습니다.`);
    const hash = createHash('sha256');
    if (resumed) await hashInto(part, hash);
    let done = resumed ? from : 0;
    const total = done + Number(res.headers.get('content-length') ?? 0);
    const file = await open(part, resumed ? 'a' : 'w', 0o600);
    try {
      for await (const chunk of res.body) {
        alive();
        done += chunk.length;
        if (done > pin.maxBytes) break;
        hash.update(chunk);
        await file.write(chunk);
        progress(label, done, total);
        onProgress?.(done, total);
      }
    } finally {
      await file.close();
      if (process.stderr.isTTY && total) process.stderr.write('\n');
    }
    if (done > pin.maxBytes || hash.digest('hex') !== pin.sha256) {
      await unlink(part);
      throw new Error(`${label} 의 크기·sha256 이 고정값과 달라 버렸습니다. 다시 시도해도 같으면 알려 주세요.`);
    }
    await replaceFile(part, dest);
  } catch (err) {
    if (stall.signal.aborted)
      throw new Error(
        `${label} 응답이 ${STALL_TIMEOUT_MS / 1000}초 동안 멈춰 중단했습니다. 다시 실행하면 이어 받습니다.`
      );
    throw err;
  } finally {
    clearTimeout(timer);
  }
}
