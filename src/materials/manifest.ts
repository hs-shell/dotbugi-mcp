import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { mkdir, open, rename, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import * as z from 'zod/v4';
import { isMaterialUrl } from './course-page.js';
import { LMS_NUMERIC_ID, MATERIALS_MANIFEST_MAX_BYTES, MATERIALS_MANIFEST_NAME } from '../constants.js';

// 디스크의 기록은 사용자·다른 프로그램이 고칠 수 있으므로 읽을 때마다 검증한다. path 는 형식만 보고, 쓸 때·지울 때 resolveInside 로 다시 확인한다
// (files 를 객체 대신 배열로 둬 "__proto__" 같은 키가 끼어들 여지를 없앤다)
const entrySchema = z.object({
  key: z.string().min(1).max(2048),
  cmid: z.number().int().positive(),
  // 리비전이 든 pluginfile 주소 (쿼리 없음). 바뀌면 다시 받는다
  url: z
    .string()
    .max(2048)
    .refine((u) => {
      const url = URL.parse(u);
      return !!url && isMaterialUrl(url) && !url.search && !url.hash;
    }),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  // 과목 폴더 기준 상대 경로
  path: z.string().min(1).max(1024),
  downloadedAt: z.iso.datetime(),
  // LMS 에서 사라졌지만 사용자가 남기기로 한 파일 — 다시 묻지 않는다
  keep: z.boolean().optional(),
});
export type ManifestEntry = z.infer<typeof entrySchema>;

const manifestSchema = z.object({
  version: z.literal(1),
  courseId: z.string().regex(LMS_NUMERIC_ID),
  files: z.array(entrySchema),
});

export interface Manifest {
  courseId: string;
  files: Map<string, ManifestEntry>;
}

const manifestPath = (courseDir: string) => join(courseDir, MATERIALS_MANIFEST_NAME);

// 과목 폴더 안(하위 폴더 포함)의 경로일 때만 절대 경로를 돌려준다. manifest 자신도 제외
export function resolveInside(courseDir: string, rel: string): string | null {
  const abs = resolve(courseDir, rel);
  const r = relative(resolve(courseDir), abs);
  if (!r || isAbsolute(r) || r.split(sep)[0] === '..' || abs === manifestPath(resolve(courseDir))) return null;
  return abs;
}

// 없으면 null. 링크·정규 파일이 아님·크기 초과·형식 오류는 손대지 않고 오류로 알린다
export async function readManifest(courseDir: string): Promise<Manifest | null> {
  const invalid = () =>
    new Error(
      `${manifestPath(courseDir)} 형식이 올바르지 않아 이 과목을 건너뜁니다. 확인 후 지우면 처음부터 다시 받습니다.`
    );
  let file;
  try {
    file = await open(
      manifestPath(courseDir),
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0)
    );
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw invalid();
  }
  try {
    const st = await file.stat();
    if (!st.isFile() || st.size > MATERIALS_MANIFEST_MAX_BYTES) throw invalid();
    let raw: unknown;
    try {
      raw = JSON.parse(await file.readFile('utf8'));
    } catch {
      throw invalid();
    }
    const parsed = manifestSchema.safeParse(raw);
    if (!parsed.success) throw invalid();
    return { courseId: parsed.data.courseId, files: new Map(parsed.data.files.map((e) => [e.key, e])) };
  } finally {
    await file.close();
  }
}

// 쓰다 만 파일을 남기지 않게 새 임시 파일(wx: 링크 등 기존 경로를 따라가지 않음)에 쓰고 rename 한다. 0600
export async function writeManifest(courseDir: string, manifest: Manifest): Promise<void> {
  await mkdir(courseDir, { recursive: true, mode: 0o700 });
  const data = manifestSchema.parse({ version: 1, courseId: manifest.courseId, files: [...manifest.files.values()] });
  const tmp = `${manifestPath(courseDir)}.${randomUUID()}.tmp`;
  await writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  await rename(tmp, manifestPath(courseDir));
}
