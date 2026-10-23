import { mkdir, open, unlink, type FileHandle } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { ATTACHMENT_MAX_BYTES, FILE_NAME_STEM_MAX_LENGTH } from '../constants.js';
import { lmsFetch } from '../lms.js';

// 과제마다 전용 폴더. 이 폴더 밖에는 쓰지 않는다
export const downloadDir = (cmid: number) => join(homedir(), 'Downloads', 'dotbugi-mcp', `assign-${cmid}`);

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i;
const EXTENSION = /\.[\p{L}\p{N}]{1,10}$/u;

// 경로 구분자·Windows 금지 문자·제어/서식 문자(방향 전환 등)를 지우고, 앞뒤 점·공백(../·숨김 파일)과 예약 이름을 피한다
export function safeFileName(raw: string): string {
  const name = raw.replace(/[/\\:*?"<>|\p{Cc}\p{Cf}]/gu, '_').replace(/^[.\s]+|[.\s]+$/gu, '');
  const ext = EXTENSION.exec(name)?.[0] ?? '';
  const stem = Array.from(name.slice(0, name.length - ext.length))
    .slice(0, FILE_NAME_STEM_MAX_LENGTH)
    .join('')
    .trimEnd();
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

const tooLarge = () => new Error(`첨부파일이 ${ATTACHMENT_MAX_BYTES / 1024 / 1024}MB 상한을 넘습니다.`);

async function writeBody(file: FileHandle, url: URL, session: string): Promise<void> {
  const res = await lmsFetch(url.href, session);
  // 리다이렉트(3xx)도 실패로 본다 — 다른 곳으로 세션을 들고 따라가지 않는다
  if (!res.ok || !res.body) throw new Error(`LMS 응답 오류 HTTP ${res.status}`);
  if (Number(res.headers.get('content-length')) > ATTACHMENT_MAX_BYTES) throw tooLarge();
  // Content-Length 는 믿지 않고 받은 바이트를 직접 센다
  const reader = res.body.getReader();
  let size = 0;
  try {
    for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) {
      size += chunk.value.byteLength;
      if (size > ATTACHMENT_MAX_BYTES) throw tooLarge();
      await file.write(chunk.value);
    }
  } catch (err) {
    await reader.cancel().catch(() => {});
    throw err;
  }
}

// 첨부파일을 dir/name 에 받는다. 같은 이름이 이미 있으면 덮어쓰지 않고 existing 으로 알린다
export async function saveAttachment(
  url: URL,
  dir: string,
  name: string,
  session: string
): Promise<{ path: string; existing: boolean }> {
  const path = resolve(dir, name);
  if (dirname(path) !== resolve(dir)) throw new Error('첨부파일 이름이 저장 폴더를 벗어납니다.');
  await mkdir(dir, { recursive: true, mode: 0o700 });
  let file: FileHandle;
  try {
    // wx: 이미 있으면(심볼릭 링크 포함) 열지 않는다
    file = await open(path, 'wx', 0o600);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return { path, existing: true };
    throw err;
  }
  // shortcut: 프로세스가 받는 도중 죽으면 덜 받은 파일이 남아 다음 호출에서 existing 이 된다, 문제가 되면 임시 이름으로 받은 뒤 옮긴다
  try {
    await writeBody(file, url, session);
  } catch (err) {
    await file.close();
    await unlink(path);
    throw err;
  }
  await file.close();
  return { path, existing: false };
}
