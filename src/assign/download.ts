import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readdir, rename, unlink, type FileHandle } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import {
  ATTACHMENT_MAX_BYTES,
  ATTACHMENT_REQUEST_TIMEOUT_MS,
  FILE_NAME_STEM_MAX_LENGTH,
  FILE_NAME_SUFFIX_MAX,
} from '../constants.js';
import { lmsFetch } from '../lms.js';

// 과제마다 전용 폴더. 이 폴더 밖에는 쓰지 않는다
export const downloadDir = (cmid: number) => join(homedir(), 'Downloads', 'dotbugi-mcp', `assign-${cmid}`);

// Windows 는 확장자 앞 공백까지 무시하고 예약 이름으로 본다 (CON .txt)
const WINDOWS_RESERVED = /^(con|prn|aux|nul|conin\$|conout\$|com[0-9¹²³]|lpt[0-9¹²³])\s*(\.|$)/i;
const EXTENSION = /\.[\p{L}\p{N}]{1,10}$/u;

// 경로 구분자·Windows 금지 문자·제어/서식 문자(방향 전환 등)를 지우고, 앞뒤 점·공백(../·숨김 파일)과 예약 이름을 피한다
export function safeFileName(raw: string): string {
  const name = raw.replace(/[/\\:*?"<>|\p{Cc}\p{Cf}]/gu, '_').replace(/^[.\s]+|[.\s]+$/gu, '');
  const ext = EXTENSION.exec(name)?.[0] ?? '';
  const stem = Array.from(name.slice(0, name.length - ext.length))
    .slice(0, FILE_NAME_STEM_MAX_LENGTH)
    .join('')
    .replace(/[.\s]+$/u, '');
  const safe = stem ? stem + ext : 'attachment';
  return WINDOWS_RESERVED.test(safe) ? `_${safe}` : safe;
}

// pluginfile 주소의 마지막 경로 조각이 파일명이다
export function attachmentName(url: URL): string {
  const last = url.pathname.slice(url.pathname.lastIndexOf('/') + 1);
  try {
    return safeFileName(decodeURIComponent(last));
  } catch {
    return safeFileName(last);
  }
}

// 파일 하나의 크기·요청 시간 상한. 강의자료(#13)는 첨부보다 크게 잡는다
export interface DownloadLimits {
  maxBytes: number;
  timeoutMs: number;
}
const ATTACHMENT_LIMITS: DownloadLimits = { maxBytes: ATTACHMENT_MAX_BYTES, timeoutMs: ATTACHMENT_REQUEST_TIMEOUT_MS };

const tooLarge = (max: number) => new Error(`파일이 ${max / 1024 / 1024}MB 상한을 넘습니다.`);

// 받은 내용의 sha256(hex)을 돌려준다
async function writeBody(file: FileHandle, url: URL, session: string, limits: DownloadLimits): Promise<string> {
  const res = await lmsFetch(url.href, session, limits.timeoutMs);
  // 리다이렉트(3xx)도 실패로 본다 — 다른 곳으로 세션을 들고 따라가지 않는다
  if (!res.ok || !res.body) throw new Error(`LMS 응답 오류 HTTP ${res.status}`);
  if (Number(res.headers.get('content-length')) > limits.maxBytes) throw tooLarge(limits.maxBytes);
  // Content-Length 는 믿지 않고 받은 바이트를 직접 센다
  const reader = res.body.getReader();
  const hash = createHash('sha256');
  let size = 0;
  try {
    for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) {
      size += chunk.value.byteLength;
      if (size > limits.maxBytes) throw tooLarge(limits.maxBytes);
      hash.update(chunk.value);
      await file.write(chunk.value);
    }
  } catch (err) {
    await reader.cancel().catch(() => {});
    throw err;
  }
  return hash.digest('hex');
}

// "이름 (n).확장자" — 기존 파일을 덮어쓰지 않고 옆에 받는다
function withSuffix(name: string, n: number): string {
  if (n === 1) return name;
  const ext = EXTENSION.exec(name)?.[0] ?? '';
  return `${name.slice(0, name.length - ext.length)} (${n})${ext}`;
}

// wx: 이미 있으면(심볼릭 링크 포함) 열지 않는다 — 비어 있는 이름을 찾을 때까지 번호를 붙인다
export async function openNew(dir: string, name: string): Promise<{ file: FileHandle; name: string; path: string }> {
  for (let n = 1; n <= FILE_NAME_SUFFIX_MAX; n++) {
    const candidate = withSuffix(name, n);
    const path = resolve(dir, candidate);
    if (dirname(path) !== resolve(dir)) throw new Error('파일 이름이 저장 폴더를 벗어납니다.');
    try {
      return { file: await open(path, 'wx', 0o600), name: candidate, path };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    }
  }
  throw new Error('같은 이름의 파일이 너무 많습니다. 저장 폴더를 정리하세요.');
}

// 받는 중인 임시 파일. safeFileName 이 앞의 점을 지우므로 LMS 파일명은 이 형식이 될 수 없다
const TEMP_NAME = /^\.dotbugi-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.part$/;

// 이전 실행이 죽으며 남긴 임시 파일을 지운다. 요청 시간 상한보다 오래 안 바뀐 것만 — 받는 중인 파일일 수 없다
async function sweepTemp(dir: string, maxAgeMs: number): Promise<void> {
  for (const entry of await readdir(dir)) {
    if (!TEMP_NAME.test(entry)) continue;
    const path = join(dir, entry);
    const st = await lstat(path).catch(() => null);
    if (st?.isFile() && Date.now() - st.mtimeMs > maxAgeMs) await unlink(path).catch(() => {});
  }
}

// dir 아래 임시 이름으로 받는다 — 중간에 죽어도 덜 받은 파일이 자료 이름으로 남지 않는다. 실패하면 임시 파일을 지운다
export async function downloadTemp(
  url: URL,
  dir: string,
  session: string,
  limits = ATTACHMENT_LIMITS
): Promise<{ path: string; sha256: string }> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await sweepTemp(dir, limits.timeoutMs);
  const path = join(dir, `.dotbugi-${randomUUID()}.part`);
  const file = await open(path, 'wx', 0o600);
  let sha256: string;
  try {
    sha256 = await writeBody(file, url, session, limits);
  } catch (err) {
    await file.close();
    await unlink(path);
    throw err;
  }
  await file.close();
  return { path, sha256 };
}

// 같은 이름이 있으면 "이름 (2).ext" 자리를 잡아(wx) 그 위로 옮긴다 — 기존 파일은 덮지 않는다
export async function placeNew(dir: string, name: string, tmpPath: string): Promise<{ name: string; path: string }> {
  const slot = await openNew(dir, name);
  await slot.file.close();
  try {
    await rename(tmpPath, slot.path);
  } catch (err) {
    await unlink(slot.path).catch(() => {});
    throw err;
  }
  return { name: slot.name, path: slot.path };
}

// 첨부파일을 dir 아래 새 파일로 받는다. 같은 이름이 있으면 번호를 붙인 이름으로 저장한다
export async function saveAttachment(
  url: URL,
  dir: string,
  name: string,
  session: string,
  limits = ATTACHMENT_LIMITS
): Promise<{ name: string; path: string; sha256: string }> {
  const tmp = await downloadTemp(url, dir, session, limits);
  try {
    return { ...(await placeNew(dir, name, tmp.path)), sha256: tmp.sha256 };
  } catch (err) {
    await unlink(tmp.path).catch(() => {});
    throw err;
  }
}
