import { lstat, readdir, readFile, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { childDir, ensureRealDir } from '../materials/sync.js';
import { moveLegacyDir, previousSemester, semesterOf, storageRoot } from '../storage.js';
import { assignDirName, safeFileName } from './download.js';

// 과제 폴더 안의 표식 — 과제 이름이 바뀌거나 다른 주차로 옮겨져도 cmid 로 같은 폴더를 다시 찾는다
const MARKER = '.dotbugi-assign.json';
const PREFIX = '과제-';
// 주차 폴더·과목 폴더 안의 과제 폴더 (노트·요약 대상에서 뺀다)
export const isAssignDirName = (name: string) => name.startsWith(PREFIX);

async function markedCmid(dir: string): Promise<number | null> {
  try {
    if (!(await lstat(join(dir, MARKER))).isFile()) return null;
    const cmid: unknown = JSON.parse(await readFile(join(dir, MARKER), 'utf8'))?.cmid;
    return Number.isSafeInteger(cmid) ? (cmid as number) : null;
  } catch {
    return null;
  }
}

// 바로 아래 실제 폴더 (숨김·링크 제외 — withFileTypes 의 isDirectory 는 링크를 따라가지 않는다)
const subdirs = async (dir: string) =>
  (await readdir(dir, { withFileTypes: true }).catch(() => []))
    .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
    .map((e) => join(dir, e.name));

// 과목 폴더와 그 아래 주차 폴더에서 이 cmid 표식이 있는 과제 폴더
async function findMarked(courseDir: string, cmid: number): Promise<string | null> {
  const all = await subdirs(courseDir);
  const parents = [courseDir, ...all.filter((d) => !isAssignDirName(basename(d)))];
  for (const parent of parents)
    for (const dir of (parent === courseDir ? all : await subdirs(parent)).filter((d) => isAssignDirName(basename(d))))
      if ((await markedCmid(dir)) === cmid) return dir;
  return null;
}

// "과제-<이름>", 이미 있으면(같은 이름의 다른 과제) "과제-<이름> (<cmid>)". 이름은 safeFileName 으로 정리돼 구분자가 없다
async function freeSlot(parent: string, title: string, cmid: number): Promise<string> {
  const base = safeFileName(`${PREFIX}${title}`);
  for (const name of [base, `${base} (${cmid})`]) {
    const dir = join(parent, name);
    if (!(await lstat(dir).catch(() => null))) return dir;
  }
  throw new Error(`같은 이름의 과제 폴더가 이미 있습니다: ${join(parent, base)}`);
}

// 예전 과제 폴더: <학기>/assign-<cmid> (이번·직전 학기), 학기 폴더 도입 전 <저장 위치>/assign-<cmid>
const legacyDirs = (cmid: number, root: string, now: Date) => {
  const semester = semesterOf(now);
  return [semester, previousSemester(semester), ''].map((s) => join(root, s, assignDirName(cmid)));
};

// 과제 폴더를 정한다 (sync 잠금 안에서만 부른다): <과목>/<N주차>/과제-<이름>/, 주차를 모르면 <과목>/과제-<이름>/.
// 표식이 있는 폴더가 있으면 그대로 이어 쓰고, 처음이면 예전 assign-<cmid> 폴더를 새 자리로 옮긴다 (.history·변경기록째).
// 옮기지 못하면 원본을 그대로 쓰고 경고를 돌려준다
export async function openAssignDir(
  courseDir: string,
  week: string | null,
  title: string,
  cmid: number,
  root = storageRoot(),
  now = new Date()
): Promise<{ dir: string; warnings: string[] }> {
  await ensureRealDir(root, courseDir);
  const found = await findMarked(courseDir, cmid);
  if (found) return { dir: found, warnings: [] };
  const parent = week ? childDir(courseDir, week) : courseDir;
  await ensureRealDir(root, parent);
  const dir = await freeSlot(parent, title, cmid);
  for (const legacy of legacyDirs(cmid, root, now)) {
    if (!(await lstat(legacy).catch(() => null))?.isDirectory()) continue;
    const warning = await moveLegacyDir(legacy, dir);
    if (warning) return { dir: legacy, warnings: [warning] };
    break;
  }
  await ensureRealDir(root, dir);
  await writeFile(join(dir, MARKER), `${JSON.stringify({ cmid })}\n`, { flag: 'wx', mode: 0o600 });
  return { dir, warnings: [] };
}
