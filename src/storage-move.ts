import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { lstat, mkdir, readdir, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';

// 다른 파일 시스템(드라이브)으로 저장 위치를 옮길 때 쓰는 복사·검증. rename 처럼 한 번에 옮길 수 없으므로
// 숨김 임시 폴더에 복사 → 파일마다 sha256 비교 → 같을 때만 제 이름으로 rename 한다 (중간에 끊겨도 반쯤 복사된 폴더가 제 이름으로 남지 않는다)

export const STAGING_PREFIX = '.dotbugi-moving-';

// 내용만 새 파일(wx: 덮어쓰지 않음)에 쓴다. fs.copyFile 은 원본 권한까지 복사(fchmod)하는데
// WSL 에 붙인 Windows·Google Drive 드라이브(drvfs)는 이를 EPERM 으로 거부해 복사 자체가 실패한다
const copyContent = (from: string, to: string) =>
  pipeline(createReadStream(from), createWriteStream(to, { flags: 'wx', mode: 0o600 }));

async function sha256(path: string): Promise<string> {
  const hash = createHash('sha256');
  await pipeline(createReadStream(path), hash);
  return hash.digest('hex');
}

// 폴더 안 상대 경로 목록 (폴더는 끝에 /). 링크·특수 파일이 있으면 null — 따라가지도, 반쯤 옮기지도 않는다
export async function listTree(dir: string, prefix = ''): Promise<string[] | null> {
  const out: string[] = [];
  for (const name of (await readdir(join(dir, prefix))).sort()) {
    const rel = join(prefix, name);
    const st = await lstat(join(dir, rel));
    if (st.isDirectory()) {
      const sub = await listTree(dir, rel);
      if (!sub) return null;
      out.push(`${rel}/`, ...sub);
    } else if (st.isFile()) out.push(rel);
    else return null;
  }
  return out;
}

// 두 폴더의 구성과 파일 내용이 같은지
export async function sameTree(a: string, b: string): Promise<boolean> {
  const [ta, tb] = await Promise.all([listTree(a), listTree(b)]);
  if (!ta || !tb || ta.join('\n') !== tb.join('\n')) return false;
  for (const rel of ta.filter((r) => !r.endsWith('/')))
    if ((await sha256(join(a, rel))) !== (await sha256(join(b, rel)))) return false;
  return true;
}

// src 폴더를 dst(아직 없어야 함)로 복사하고 검증한다. 실패하면 임시 폴더를 지우고 던진다. 원본은 건드리지 않는다
export async function copyTreeVerified(src: string, dst: string, stagingName: string): Promise<void> {
  const tree = await listTree(src);
  if (!tree) throw new Error('링크나 특수 파일이 있어 옮기지 않았습니다.');
  const staging = join(dst, '..', `${STAGING_PREFIX}${stagingName}`);
  // 지난번에 끊겨 남은 임시 폴더는 우리 것이다 — 지우고 처음부터 복사한다
  await rm(staging, { recursive: true, force: true });
  try {
    await mkdir(staging, { mode: 0o700 });
    for (const rel of tree) {
      if (rel.endsWith('/')) await mkdir(join(staging, rel), { mode: 0o700 });
      else await copyContent(join(src, rel), join(staging, rel));
    }
    if (!(await sameTree(src, staging))) throw new Error('복사한 내용이 원본과 달라 옮기지 않았습니다.');
    await rename(staging, dst);
  } catch (err) {
    await rm(staging, { recursive: true, force: true }).catch(() => {});
    throw err;
  }
}
