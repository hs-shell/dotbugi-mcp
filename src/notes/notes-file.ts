import { randomUUID } from 'node:crypto';
import { lstat, readFile, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import * as z from 'zod/v4';
import { safeFileName } from '../assign/download.js';
import { LMS_DATA_NOTICE } from '../constants.js';
import { replaceFile } from '../player/state.js';

// 이 줄로 시작하는 파일만 우리가 쓴 노트로 보고 다시 쓴다 (같은 이름의 사용자 파일은 덮지 않음). 요약은 SUMMARY_MARK
const MARK = '<!-- dotbugi-mcp: 강의 노트 -->';
export const SUMMARY_MARK = '<!-- dotbugi-mcp: 핵심 요약 -->';
const META_PREFIX = '<!-- dotbugi-mcp-meta ';

export const notesName = (week: string) => safeFileName(`노트-${week}.md`);

// 파일은 사용자가 고칠 수 있다 — 읽을 때마다 검증
const metaSchema = z.object({
  sources: z.array(z.object({ name: z.string().max(1024), sha256: z.string().regex(/^[0-9a-f]{64}$/) })).max(10_000),
  instructions: z.string().max(10_000),
});
export type NotesMeta = z.infer<typeof metaSchema>;

// 없으면 null, 우리 파일이 아니면(다른 파일·링크·깨진 기록) 'other'
export async function readNotesMeta(path: string, mark = MARK): Promise<NotesMeta | 'other' | null> {
  const st = await lstat(path).catch((err: NodeJS.ErrnoException) => {
    if (err.code === 'ENOENT') return null;
    throw err;
  });
  if (!st) return null;
  if (!st.isFile()) return 'other';
  const [first, meta] = (await readFile(path, 'utf8')).split('\n', 2);
  if (first !== mark || !meta?.startsWith(META_PREFIX) || !meta.endsWith(' -->')) return 'other';
  try {
    const parsed = metaSchema.safeParse(JSON.parse(meta.slice(META_PREFIX.length, -4)));
    return parsed.success ? parsed.data : 'other';
  } catch {
    return 'other';
  }
}

// 첫 줄 표식, 둘째 줄 지문·지시사항(JSON — 주석이 끝나지 않게 < > 는 이스케이프), 셋째 줄 'LMS 데이터' 안내
export const buildNotes = (content: string, meta: NotesMeta, mark = MARK) =>
  [
    mark,
    `${META_PREFIX}${JSON.stringify(meta).replace(/</g, '\\u003c').replace(/>/g, '\\u003e')} -->`,
    LMS_DATA_NOTICE,
    '',
    content.trim(),
    '',
  ].join('\n');

// 우리 노트만 바꾼다. 이미 있으면 replace 일 때만 (사용자 확인을 거친 다시 만들기)
export const writeNotes = (dir: string, week: string, md: string, replace: boolean) =>
  writeOwnFile(join(dir, notesName(week)), md, replace, MARK, '노트');

// mark 로 시작하는 우리 파일만 임시 파일 → rename 으로 바꾼다 (what: 오류 문구의 이름)
export async function writeOwnFile(
  path: string,
  md: string,
  replace: boolean,
  mark: string,
  what: string
): Promise<string> {
  const existing = await readNotesMeta(path, mark);
  if (existing === 'other') throw new Error(`같은 이름의 다른 파일이 있어 ${what} 파일을 쓰지 않았습니다: ${path}`);
  if (existing && !replace)
    throw new Error(
      `${what} 파일이 이미 있습니다: ${path} — 사용자가 다시 만들기에 동의했으면 replace: true 로 다시 호출하세요.`
    );
  const tmp = join(dirname(path), `.dotbugi-${randomUUID()}.part`);
  await writeFile(tmp, md, { flag: 'wx', mode: 0o600 });
  try {
    await replaceFile(tmp, path);
  } catch (err) {
    await unlink(tmp).catch(() => {});
    throw err;
  }
  return path;
}
