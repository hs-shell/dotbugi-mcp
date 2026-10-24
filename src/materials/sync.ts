import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, mkdir, rename, stat, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { getIndexPageLink, type CourseBase, type FetchHtml } from '@dotbugi/lms-parser';
import { attachmentName, downloadTemp, placeNew, safeFileName } from '../assign/download.js';
import {
  LMS_NUMERIC_ID,
  MATERIAL_MAX_BYTES,
  MATERIAL_MAX_BYTES_PER_RUN,
  MATERIAL_MAX_FILES_PER_RUN,
  MATERIAL_REQUEST_TIMEOUT_MS,
  MATERIALS_LOCK_NAME,
} from '../constants.js';
import { createFetchHtml, limit } from '../lms-html.js';
import { SessionExpiredError } from '../lms.js';
import { acquireLock } from '../player/lock.js';
import { redact } from '../redact.js';
import { listCourses } from '../tasks/collect.js';
import { clean } from '../tasks/text.js';
import { fileKey, folderFileUrls, parseCoursePage, resourceFileUrl, type CourseModule } from './course-page.js';
import { readManifest, resolveInside, writeManifest, type Manifest, type ManifestEntry } from './manifest.js';

export type FileStatus = 'added' | 'updated' | 'unchanged';
export interface SyncedFile {
  course: string;
  week: string;
  path: string;
  status: FileStatus;
}
// LMS 에서 사라진 파일. courseDir·key·sha256(보고 시점 로컬 해시)은 CLI·delete_materials 가 삭제할 때 다시 확인하는 데 쓴다 (MCP 결과로는 내보내지 않음)
export interface RemovedFile {
  course: string;
  path: string;
  locallyModified: boolean;
  courseDir: string;
  key: string;
  sha256: string;
}
export interface SyncResult {
  root: string;
  files: SyncedFile[];
  removed: RemovedFile[];
  warnings: string[];
}

export const materialsRoot = () => join(homedir(), 'Downloads', 'dotbugi-mcp');
const LIMITS = { maxBytes: MATERIAL_MAX_BYTES, timeoutMs: MATERIAL_REQUEST_TIMEOUT_MS };

// MCP 도구와 CLI 가 같은 manifest 를 번갈아 덮지 않게 한 번에 하나만 돌린다
export async function withSyncLock<T>(task: () => Promise<T>): Promise<T> {
  const release = await acquireLock(
    join(materialsRoot(), MATERIALS_LOCK_NAME),
    '다른 강의자료 동기화(sync_materials 또는 dotbugi-mcp sync)가 실행 중입니다. 끝난 뒤 다시 실행하세요.'
  );
  try {
    return await task();
  } finally {
    await release();
  }
}

// 과목·주차 이름도 파일명처럼 정리하고, 바로 아래 폴더인지 다시 확인한다
export function childDir(parent: string, raw: string): string {
  const dir = resolve(parent, safeFileName(raw));
  if (dirname(dir) !== resolve(parent)) throw new Error('폴더 이름이 저장 폴더를 벗어납니다.');
  return dir;
}

// 문자열 검사만으로는 링크 폴더를 따라 밖에 쓸 수 있다 — root 아래 각 단계가 링크가 아닌 실제 폴더인지 lstat 으로 확인한다.
// create 면 없는 단계를 만들고, 아니면 없는 단계에서 멈춘다 (없으면 따라갈 링크도 없다)
export async function ensureRealDir(root: string, dir: string, create = true): Promise<void> {
  const rel = relative(root, dir);
  if (!rel || isAbsolute(rel) || rel.split(sep)[0] === '..') throw new Error('저장 폴더 밖의 경로입니다.');
  if (create) await mkdir(root, { recursive: true, mode: 0o700 });
  let current = root;
  for (const part of rel.split(sep)) {
    current = join(current, part);
    if (create)
      await mkdir(current, { mode: 0o700 }).catch((err: NodeJS.ErrnoException) => {
        if (err.code !== 'EEXIST') throw err;
      });
    const st = await lstat(current).catch((err: NodeJS.ErrnoException) => {
      if (err.code === 'ENOENT' && !create) return null;
      throw err;
    });
    if (!st) return;
    if (!st.isDirectory()) throw new Error(`${current} 가 폴더가 아니라(링크 등) 건너뜁니다.`);
  }
}

// 로컬 파일 해시. 없으면 null, 정규 파일이 아니면(링크 등) 어떤 해시와도 다른 '' — 수정된 파일로 보고 건드리지 않는다
export async function localHash(path: string): Promise<string | null> {
  const st = await lstat(path).catch((err: NodeJS.ErrnoException) => {
    if (err.code === 'ENOENT') return null;
    throw err;
  });
  if (!st) return null;
  if (!st.isFile()) return '';
  const hash = createHash('sha256');
  await pipeline(createReadStream(path), hash);
  return hash.digest('hex');
}

type Remote = CourseModule & { url: URL };
type Step = { status: FileStatus; path: string; entry: ManifestEntry; downloaded: boolean; warning?: string };
interface Budget {
  files: number;
  bytes: number;
  capped: boolean;
}

// 파일 하나 — 새 파일·리비전이 바뀐 파일만 받는다. 받은 내용이 같으면 쓰지 않고, 사용자가 고친 파일은 덮어쓰지 않는다.
// 한 번 실행의 상한에 걸리면 null (받지 않음)
async function syncFile(
  file: Remote,
  key: string,
  prev: ManifestEntry | undefined,
  root: string,
  courseDir: string,
  session: string,
  budget: Budget
): Promise<Step | null> {
  const url = file.url.href;
  const prevPath = prev && resolveInside(courseDir, prev.path);
  const entry = (path: string, sha256: string): ManifestEntry => ({
    key,
    cmid: file.cmid,
    url,
    sha256,
    path: relative(courseDir, path),
    downloadedAt: new Date().toISOString(),
  });
  // 리비전이 같고 파일이 있으면 요청하지 않는다
  if (prev && prevPath && prev.url === url && (await lstat(prevPath).catch(() => null)))
    return { status: 'unchanged', path: prevPath, entry: { ...prev, keep: undefined }, downloaded: false };
  if (budget.files >= MATERIAL_MAX_FILES_PER_RUN || budget.bytes >= MATERIAL_MAX_BYTES_PER_RUN) {
    budget.capped = true;
    return null;
  }

  const weekDir = childDir(courseDir, file.week);
  await ensureRealDir(root, weekDir);
  const name = attachmentName(file.url);
  // 임시 이름으로 받고 다 받은 뒤에만 제자리로 옮긴다
  const part = await limit(() => downloadTemp(file.url, weekDir, session, LIMITS));
  budget.files++;
  try {
    budget.bytes += (await stat(part.path)).size;
    // 받는 동안 사용자가 고쳤을 수 있으므로 받은 뒤, 바꾸기 직전에 잰다
    const local = prevPath ? await localHash(prevPath) : null;
    if (prev && prevPath && local !== null) {
      if (part.sha256 === prev.sha256) {
        await unlink(part.path);
        return { status: 'unchanged', path: prevPath, entry: { ...prev, url, keep: undefined }, downloaded: true };
      }
      // 받은 그대로인 파일만 새 버전으로 바꾼다
      if (local === prev.sha256) {
        await ensureRealDir(root, dirname(prevPath), false);
        await rename(part.path, prevPath);
        return { status: 'updated', path: prevPath, entry: entry(prevPath, part.sha256), downloaded: true };
      }
      const slot = await placeNew(weekDir, name, part.path);
      return {
        status: 'updated',
        path: slot.path,
        entry: entry(slot.path, part.sha256),
        downloaded: true,
        warning: `받은 뒤 수정된 파일이라 덮어쓰지 않고 새 버전을 ${slot.path} 에 저장했습니다 (기존: ${prevPath}).`,
      };
    }
    const slot = await placeNew(weekDir, name, part.path);
    return {
      status: 'added',
      path: slot.path,
      entry: entry(slot.path, part.sha256),
      downloaded: true,
      warning:
        slot.name === name ? undefined : `같은 이름의 파일이 이미 있어 덮어쓰지 않고 ${slot.path} 에 저장했습니다.`,
    };
  } catch (err) {
    await unlink(part.path).catch(() => {});
    throw err;
  }
}

// 과목 폴더는 "<과목>". 같은 이름의 다른 과목이 이미 쓰고 있으면 "<과목> (<과목 번호>)"
export async function openCourseDir(root: string, title: string, courseId: string) {
  for (const name of [title, `${title} (${courseId})`]) {
    const dir = childDir(root, name);
    await ensureRealDir(root, dir, false);
    const manifest = await readManifest(dir);
    if (!manifest || manifest.courseId === courseId)
      return { dir, manifest: manifest ?? { courseId, files: new Map<string, ManifestEntry>() } };
  }
  throw new Error('같은 이름의 다른 과목 폴더가 있어 건너뜁니다.');
}

async function syncCourse(
  course: CourseBase,
  root: string,
  session: string,
  fetchHtml: FetchHtml,
  out: SyncResult,
  budget: Budget
) {
  const title = clean(course.courseTitle);
  const warn = (message: string) => out.warnings.push(redact(`[${title}] ${message}`, [session]));
  const errorMessage = (err: unknown) => {
    if (err instanceof SessionExpiredError) throw err;
    return err instanceof Error ? err.message : String(err);
  };
  if (!LMS_NUMERIC_ID.test(course.courseId)) throw new Error('과목 번호 형식이 올바르지 않습니다.');
  const { dir: courseDir, manifest } = await openCourseDir(root, title, course.courseId);
  const save = async (m: Manifest) => {
    await ensureRealDir(root, courseDir);
    await writeManifest(courseDir, m);
  };

  const modules = parseCoursePage(await fetchHtml(getIndexPageLink(course.courseId)));
  // 목록을 못 읽은 모듈의 파일은 '삭제됨'으로 보지 않는다
  const failed = new Set<number>();
  const remote = (
    await Promise.all(
      modules.map(async (m): Promise<Remote[]> => {
        try {
          const urls =
            m.type === 'resource' ? [await resourceFileUrl(m.cmid, session)] : await folderFileUrls(m.cmid, fetchHtml);
          return urls.map((url) => ({ ...m, url }));
        } catch (err) {
          failed.add(m.cmid);
          warn(`자료(id=${m.cmid}) 목록을 읽지 못했습니다: ${errorMessage(err)}`);
          return [];
        }
      })
    )
  ).flat();

  const seen = new Set<string>();
  let dirty = false;
  // 하나씩 받는다 — LMS 에 큰 요청을 겹쳐 보내지 않는다
  for (const file of remote) {
    const key = fileKey(file.cmid, file.url);
    if (seen.has(key)) continue;
    seen.add(key);
    try {
      const step = await syncFile(file, key, manifest.files.get(key), root, courseDir, session, budget);
      if (!step) continue;
      manifest.files.set(key, step.entry);
      dirty = true;
      // 받을 때마다 기록한다 — 세션 만료·Ctrl+C 로 멈춰도 받은 파일이 다음에 '새 파일'로 중복되지 않게
      if (step.downloaded) await save(manifest);
      out.files.push({ course: title, week: safeFileName(file.week), path: step.path, status: step.status });
      if (step.warning) warn(step.warning);
    } catch (err) {
      warn(`${attachmentName(file.url)} 을(를) 받지 못했습니다: ${errorMessage(err)}`);
    }
  }
  // LMS 에서 사라진 파일은 지우지 않고 알리기만 한다 (삭제는 CLI 확인 또는 delete_materials 의 사용자 승인)
  for (const [key, entry] of manifest.files) {
    if (seen.has(key) || failed.has(entry.cmid) || entry.keep) continue;
    const path = resolveInside(courseDir, entry.path);
    const local = path && (await localHash(path));
    if (path && local !== null) {
      out.removed.push({ course: title, path, locallyModified: local !== entry.sha256, courseDir, key, sha256: local });
    } else {
      // 로컬에도 없으면(또는 폴더 밖을 가리키면) 기록만 정리한다
      manifest.files.delete(key);
      dirty = true;
    }
  }
  if (dirty) await save(manifest);
}

// 추적 중인 강좌(dotbugi-mcp courses, 기본: 비교과 제외)의 강의자료를 ~/Downloads/dotbugi-mcp/<과목>/<N주차>/ 에 맞춘다. course 는 과목명 일부(대소문자 무시)
export async function syncMaterials(session: string, course?: string): Promise<SyncResult> {
  const fetchHtml = createFetchHtml(session);
  const out: SyncResult = { root: materialsRoot(), files: [], removed: [], warnings: [] };
  const budget: Budget = { files: 0, bytes: 0, capped: false };
  const filter = course?.toLowerCase();
  const courses = (await listCourses(fetchHtml)).filter(
    (c) => !filter || clean(c.courseTitle).toLowerCase().includes(filter)
  );
  if (courses.length === 0) out.warnings.push('조건에 맞는 과목이 없습니다.');
  // 과목은 차례로 — 동시 요청은 전역 limiter 가 3개로 묶는다
  for (const c of courses) {
    try {
      await syncCourse(c, out.root, session, fetchHtml, out, budget);
    } catch (err) {
      if (err instanceof SessionExpiredError) throw err;
      out.warnings.push(
        redact(`[${clean(c.courseTitle)}] ${err instanceof Error ? err.message : String(err)}`, [session])
      );
    }
  }
  if (budget.capped)
    out.warnings.push(
      `한 번에 받는 상한(${MATERIAL_MAX_FILES_PER_RUN}개 또는 ${MATERIAL_MAX_BYTES_PER_RUN / 1024 ** 3}GB)에 걸려 나머지는 받지 않았습니다. 다시 실행하면 이어서 받습니다.`
    );
  return out;
}

export type RemoveOutcome = 'deleted' | 'kept' | 'missing' | 'modified' | 'outside';

// 삭제 확인 결과 반영 (CLI·delete_materials 공용). 기록·경로를 다시 읽어 검증하고, 보고한 그 파일(같은 경로·같은 내용)일 때만 지운다.
// 남기면 keep 으로 표시해 다시 묻지 않는다. 경로 단계가 링크면 ensureRealDir 가 던진다
export async function resolveRemoved(item: RemovedFile, remove: boolean): Promise<RemoveOutcome> {
  const root = materialsRoot();
  await ensureRealDir(root, item.courseDir, false);
  const manifest = await readManifest(item.courseDir);
  const entry = manifest?.files.get(item.key);
  if (!manifest || !entry) return 'missing';
  let outcome: RemoveOutcome = 'kept';
  if (remove) {
    const path = resolveInside(item.courseDir, entry.path);
    if (path === null) return 'outside';
    if (path !== item.path) return 'modified';
    await ensureRealDir(root, dirname(path), false);
    const local = await localHash(path);
    // '' 은 정규 파일이 아님(링크 등) — 따라가지 않는다
    if (local === null) return 'missing';
    if (local === '') return 'outside';
    if (local !== item.sha256) return 'modified';
    await unlink(path);
    outcome = 'deleted';
    manifest.files.delete(item.key);
  } else {
    manifest.files.set(item.key, { ...entry, keep: true });
  }
  await ensureRealDir(root, item.courseDir);
  await writeManifest(item.courseDir, manifest);
  return outcome;
}
