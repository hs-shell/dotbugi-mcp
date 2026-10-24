import { existsSync, lstatSync, mkdirSync, writeFileSync } from 'node:fs';
import { lstat, mkdir, rename } from 'node:fs/promises';
import { homedir, userInfo } from 'node:os';
import { basename, dirname, isAbsolute, join } from 'node:path';
import * as z from 'zod/v4';
import { LMS_UTC_OFFSET } from './constants.js';
import { log } from './log.js';
import { isWsl } from './platform.js';
import { readStateFile, writeStateFile } from './player/state.js';
import { wslLocalAppData } from './wsl-paths.js';

// 저장 위치·학기 폴더 규칙의 단일 출처 — 강의자료·과제 첨부·녹취·요약.md 가 모두 <저장 위치>/<YYYY-N학기>/ 아래에 쌓인다.
// homedir() 는 부를 때마다 읽는다 (테스트가 홈을 바꾼다)
export const storageConfigFile = () => join(homedir(), '.config', 'dotbugi-mcp', 'storage.json');
// WSL 이면 Windows 탐색기·Drive 에서 보이도록 Windows 사용자 다운로드 폴더. 단 WSL 안에 이미 받아 둔 자료가 있으면 그대로 쓰고
// (옮기기는 set_storage_dir 승인으로), HOME 을 바꾼 격리 실행(테스트 등)에서는 그 HOME 밖으로 새지 않게 리눅스 쪽에 둔다
export function defaultStorageRoot(): string {
  const linux = join(homedir(), 'Downloads', 'dotbugi-mcp');
  if (!isWsl() || existsSync(linux) || homedir() !== userInfo().homedir) return linux;
  const local = wslLocalAppData();
  if (!local || basename(dirname(local)) !== 'AppData') return linux;
  const windows = join(dirname(dirname(local)), 'Downloads', 'dotbugi-mcp');
  // 한 번 고른 Windows 쪽 기본 위치는 설정에 고정한다 — 다음 실행에서 PowerShell 조회가 실패(시간 초과 등)해
  // 리눅스 쪽으로 받아 자료가 두 곳으로 갈라지지 않게. wx 라 이미 있는 설정(깨진 것·사용자가 고른 것)은 덮어쓰지 않는다
  try {
    mkdirSync(dirname(storageConfigFile()), { recursive: true, mode: 0o700 });
    writeFileSync(storageConfigFile(), `${JSON.stringify({ version: 1, root: windows }, null, 2)}\n`, {
      mode: 0o600,
      flag: 'wx',
    });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST')
      log(`기본 저장 위치를 설정에 남기지 못했습니다: ${String(err)}`);
  }
  return windows;
}

const storageConfigSchema = z.object({
  version: z.literal(1),
  // 디스크의 값은 사용자가 고칠 수 있다 — 절대 경로·제어·서식 문자(bidi·제로폭 등) 없음만 받는다 (링크 검사는 쓸 때 ensureRealDir)
  root: z
    .string()
    .max(4096)
    .refine((p) => isAbsolute(p) && !/[\p{Cc}\p{Cf}]/u.test(p)),
  // 다른 드라이브로 복사해 옮긴 뒤 원본 삭제가 끝나지 않은 옛 위치 (set_storage_dir 재실행 때 정리)
  movedFrom: z
    .string()
    .max(4096)
    .refine((p) => isAbsolute(p) && !/[\p{Cc}\p{Cf}]/u.test(p))
    .optional(),
});
export type StorageConfig = z.infer<typeof storageConfigSchema>;

// 없으면 null. 깨진 파일은 알리고 기본 위치로 보되, strict(옮기기 전)면 엉뚱한 폴더를 옮기지 않게 오류
export function readStorageConfig(file = storageConfigFile(), strict = false): StorageConfig | null {
  const config = readStateFile(file, storageConfigSchema);
  if (config || !lstatSync(file, { throwIfNoEntry: false })) return config;
  const message = `저장 위치 설정 파일을 읽지 못했습니다 (형식 오류 등): ${file} — 지우면 기본 위치로 돌아갑니다.`;
  if (strict) throw new Error(`${message} 바꾸지 않았습니다.`);
  log(`${message} 지금은 기본 위치(${defaultStorageRoot()})를 씁니다.`);
  return null;
}

export const writeStorageConfig = (root: string, file = storageConfigFile(), movedFrom?: string) =>
  writeStateFile(file, storageConfigSchema, { version: 1, root, ...(movedFrom ? { movedFrom } : {}) });

export const storageRoot = () => readStorageConfig()?.root ?? defaultStorageRoot();

// '1970-01-01T00:00:00+09:00' 은 UTC 로 -9시간 — 그 부호를 뒤집으면 LMS 시간대의 오프셋(ms)
const LMS_OFFSET_MS = -Date.parse(`1970-01-01T00:00:00${LMS_UTC_OFFSET}`);

// 3~8월 그해 1학기, 9~12월 그해 2학기, 1~2월 전년도 2학기 (계절학기도 달 기준). 실행 환경 시간대가 아니라 한국 시간으로 자른다
export function semesterOf(date: Date): string {
  const kst = new Date(date.getTime() + LMS_OFFSET_MS);
  const year = kst.getUTCFullYear();
  const month = kst.getUTCMonth() + 1;
  if (month >= 3 && month <= 8) return `${year}-1학기`;
  return `${month >= 9 ? year : year - 1}-2학기`;
}

// 바로 앞 학기 ('2026-1학기' → '2025-2학기', '2026-2학기' → '2026-1학기')
export function previousSemester(semester: string): string {
  const [year, n] = semester.split(/-|학기/).map(Number);
  return n === 2 ? `${year}-1학기` : `${year - 1}-2학기`;
}

export const semesterDir = (date = new Date(), root = storageRoot()) => join(root, semesterOf(date));

// 학기 폴더 도입 전 구조(<저장 위치>/<이름>/)를 <저장 위치>/<학기>/<이름>/ 으로 옮긴다. 같은 파일 시스템 안의 rename 만 —
// 대상이 이미 있거나 옮기지 못하면 덮어쓰거나 합치지 않고 경고만 돌려준다. 옮겼거나 옮길 것이 없으면 null.
// from 이 링크·파일이면 옮기지 않는다 (링크를 따라 저장 위치 밖을 끌어오지 않게)
export async function moveLegacyDir(from: string, to: string): Promise<string | null> {
  const src = await lstat(from).catch(() => null);
  if (!src?.isDirectory()) return null;
  if (await lstat(to).catch(() => null))
    return `예전 폴더 ${from} 를 옮기지 않았습니다: ${to} 가 이미 있습니다. 확인 후 직접 정리하세요.`;
  try {
    await mkdir(dirname(to), { recursive: true, mode: 0o700 });
    // 학기 폴더가 링크면 그 너머로 옮기지 않는다
    if (!(await lstat(dirname(to))).isDirectory()) throw new Error(`${dirname(to)} 가 폴더가 아닙니다(링크 등).`);
    await rename(from, to);
    return null;
  } catch (err) {
    return `예전 폴더 ${from} 를 ${to} 로 옮기지 못했습니다: ${err instanceof Error ? err.message : String(err)}`;
  }
}
