import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, rename, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { getIndexPageLink, type CourseBase, type FetchHtml } from '@dotbugi/lms-parser';
import { attachmentName, safeFileName, saveAttachment } from '../assign/download.js';
import { LMS_NUMERIC_ID, MATERIAL_MAX_BYTES, MATERIAL_REQUEST_TIMEOUT_MS } from '../constants.js';
import { createFetchHtml, limit } from '../lms-html.js';
import { SessionExpiredError } from '../lms.js';
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
// LMS 에서 사라진 파일. courseDir·key 는 CLI 가 삭제 여부를 기록할 때 쓴다 (MCP 결과로는 내보내지 않음)
export interface RemovedFile {
  course: string;
  path: string;
  locallyModified: boolean;
  courseDir: string;
  key: string;
}
export interface SyncResult {
  root: string;
  files: SyncedFile[];
  removed: RemovedFile[];
  warnings: string[];
}

export const materialsRoot = () => join(homedir(), 'Downloads', 'dotbugi-mcp');
const LIMITS = { maxBytes: MATERIAL_MAX_BYTES, timeoutMs: MATERIAL_REQUEST_TIMEOUT_MS };

// 과목·주차 이름도 파일명처럼 정리하고, 바로 아래 폴더인지 다시 확인한다
export function childDir(parent: string, raw: string): string {
  const dir = resolve(parent, safeFileName(raw));
  if (dirname(dir) !== resolve(parent)) throw new Error('폴더 이름이 저장 폴더를 벗어납니다.');
  return dir;
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
type Step = { status: FileStatus; path: string; entry: ManifestEntry; warning?: string };

// 파일 하나 — 새 파일·리비전이 바뀐 파일만 받는다. 받은 내용이 같으면 쓰지 않고, 사용자가 고친 파일은 덮어쓰지 않는다
async function syncFile(
  file: Remote,
  key: string,
  prev: ManifestEntry | undefined,
  courseDir: string,
  session: string
): Promise<Step> {
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
    return { status: 'unchanged', path: prevPath, entry: { ...prev, keep: undefined } };

  // 받기 전에 해시를 잰다 (받은 파일이 비어 있던 같은 경로에 놓일 수 있다)
  const local = prevPath ? await localHash(prevPath) : null;
  const name = attachmentName(file.url);
  // 같은 이름이 있으면 "이름 (2).ext" 로 받는다 (wx — 기존 파일·링크를 열지 않음)
  const saved = await limit(() => saveAttachment(file.url, childDir(courseDir, file.week), name, session, LIMITS));
  if (prev && prevPath && local !== null) {
    if (saved.sha256 === prev.sha256) {
      await unlink(saved.path);
      return { status: 'unchanged', path: prevPath, entry: { ...prev, url, keep: undefined } };
    }
    // 받은 그대로인 파일만 새 버전으로 바꾼다
    if (local === prev.sha256) {
      await rename(saved.path, prevPath);
      return { status: 'updated', path: prevPath, entry: entry(prevPath, saved.sha256) };
    }
    return {
      status: 'updated',
      path: saved.path,
      entry: entry(saved.path, saved.sha256),
      warning: `받은 뒤 수정된 파일이라 덮어쓰지 않고 새 버전을 ${saved.path} 에 저장했습니다 (기존: ${prevPath}).`,
    };
  }
  return {
    status: 'added',
    path: saved.path,
    entry: entry(saved.path, saved.sha256),
    warning:
      saved.name === name ? undefined : `같은 이름의 파일이 이미 있어 덮어쓰지 않고 ${saved.path} 에 저장했습니다.`,
  };
}

async function syncCourse(course: CourseBase, root: string, session: string, fetchHtml: FetchHtml, out: SyncResult) {
  const title = clean(course.courseTitle);
  const warn = (message: string) => out.warnings.push(redact(`[${title}] ${message}`, [session]));
  const errorMessage = (err: unknown) => {
    if (err instanceof SessionExpiredError) throw err;
    return err instanceof Error ? err.message : String(err);
  };
  if (!LMS_NUMERIC_ID.test(course.courseId)) throw new Error('과목 번호 형식이 올바르지 않습니다.');
  const courseDir = childDir(root, title);
  const manifest: Manifest = (await readManifest(courseDir)) ?? { courseId: course.courseId, files: new Map() };
  if (manifest.courseId !== course.courseId)
    throw new Error(`${courseDir} 는 같은 이름의 다른 과목 폴더라 건너뜁니다.`);

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
  try {
    // 하나씩 받는다 — LMS 에 큰 요청을 겹쳐 보내지 않는다
    for (const file of remote) {
      const key = fileKey(file.cmid, file.url);
      if (seen.has(key)) continue;
      seen.add(key);
      try {
        const step = await syncFile(file, key, manifest.files.get(key), courseDir, session);
        manifest.files.set(key, step.entry);
        out.files.push({ course: title, week: safeFileName(file.week), path: step.path, status: step.status });
        if (step.warning) warn(step.warning);
      } catch (err) {
        warn(`${attachmentName(file.url)} 을(를) 받지 못했습니다: ${errorMessage(err)}`);
      }
    }
    // LMS 에서 사라진 파일은 지우지 않고 알리기만 한다 (삭제는 CLI 에서 사용자가 하나씩 확인)
    for (const [key, entry] of manifest.files) {
      if (seen.has(key) || failed.has(entry.cmid) || entry.keep) continue;
      const path = resolveInside(courseDir, entry.path);
      const local = path && (await localHash(path));
      // 로컬에도 없으면 기록만 정리한다
      if (!path || local === null) manifest.files.delete(key);
      else out.removed.push({ course: title, path, locallyModified: local !== entry.sha256, courseDir, key });
    }
  } finally {
    // 세션 만료 등으로 중간에 멈춰도 그때까지 받은 기록은 남긴다
    if (manifest.files.size > 0 || seen.size > 0) await writeManifest(courseDir, manifest);
  }
}

// 수강 과목(비교과 제외)의 강의자료를 ~/Downloads/dotbugi-mcp/<과목>/<N주차>/ 에 맞춘다. course 는 과목명 일부(대소문자 무시)
export async function syncMaterials(session: string, course?: string): Promise<SyncResult> {
  const fetchHtml = createFetchHtml(session);
  const out: SyncResult = { root: materialsRoot(), files: [], removed: [], warnings: [] };
  const filter = course?.toLowerCase();
  const courses = (await listCourses(fetchHtml)).filter(
    (c) => !filter || clean(c.courseTitle).toLowerCase().includes(filter)
  );
  if (courses.length === 0) out.warnings.push('조건에 맞는 과목이 없습니다.');
  // 과목은 차례로 — 동시 요청은 전역 limiter 가 3개로 묶는다
  for (const c of courses) {
    try {
      await syncCourse(c, out.root, session, fetchHtml, out);
    } catch (err) {
      if (err instanceof SessionExpiredError) throw err;
      out.warnings.push(
        redact(`[${clean(c.courseTitle)}] ${err instanceof Error ? err.message : String(err)}`, [session])
      );
    }
  }
  return out;
}

// CLI 확인 결과 반영. 지우기 전에 기록·경로를 다시 읽어 검증하고, 남기면 keep 으로 표시해 다시 묻지 않는다
export async function resolveRemoved(item: RemovedFile, remove: boolean): Promise<void> {
  const manifest = await readManifest(item.courseDir);
  const entry = manifest?.files.get(item.key);
  if (!manifest || !entry) return;
  if (remove) {
    const path = resolveInside(item.courseDir, entry.path);
    if (path && (await lstat(path).catch(() => null))?.isFile()) await unlink(path);
    manifest.files.delete(item.key);
  } else {
    manifest.files.set(item.key, { ...entry, keep: true });
  }
  await writeManifest(item.courseDir, manifest);
}
