import { mkdir, mkdtemp, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ensureRealDir } from '../materials/sync.js';
import {
  ensureStorageRoot,
  missingStorageRootMessage,
  moveLegacyDir,
  previousSemester,
  readStorageConfig,
  semesterOf,
  storageConfigFile,
  storageRoot,
  writeStorageConfig,
} from '../storage.js';

const state = vi.hoisted(() => ({ home: '', wsl: false }));
vi.mock('node:os', async (orig) => ({ ...(await orig<typeof import('node:os')>()), homedir: () => state.home }));
vi.mock('../platform.js', () => ({ isWsl: () => state.wsl }));
vi.mock('../wsl-paths.js', async (orig) => ({
  ...(await orig<typeof import('../wsl-paths.js')>()),
  wslAutomountRoot: () => '/mnt/',
}));

beforeEach(async () => {
  state.home = await mkdtemp(join(tmpdir(), 'dotbugi-storage-'));
});
afterEach(async () => {
  state.wsl = false;
  await rm(state.home, { recursive: true, force: true });
});

describe('semesterOf', () => {
  it.each([
    ['2026-02-28T12:00:00+09:00', '2025-2학기'],
    ['2026-03-01T00:00:00+09:00', '2026-1학기'],
    ['2026-08-31T23:59:59+09:00', '2026-1학기'],
    ['2026-09-01T00:00:00+09:00', '2026-2학기'],
    ['2026-12-31T23:59:59+09:00', '2026-2학기'],
    ['2027-01-01T00:00:00+09:00', '2026-2학기'],
    // UTC 로는 아직 2월 28일 15시지만 한국은 3월 1일 0시
    ['2026-02-28T15:00:00Z', '2026-1학기'],
    ['2026-02-28T14:59:59Z', '2025-2학기'],
    // UTC 로는 8월 31일 15시 — 한국은 9월 1일
    ['2026-08-31T15:00:00Z', '2026-2학기'],
  ])('%s → %s', (iso, semester) => expect(semesterOf(new Date(iso))).toBe(semester));
});

describe('previousSemester', () => {
  it.each([
    ['2026-1학기', '2025-2학기'],
    ['2026-2학기', '2026-1학기'],
  ])('%s → %s', (s, prev) => expect(previousSemester(s)).toBe(prev));
});

describe('저장 위치 설정', () => {
  it('설정이 없으면 ~/Downloads/dotbugi-mcp, 저장하면 그 값을 쓴다', async () => {
    expect(storageRoot()).toBe(join(state.home, 'Downloads', 'dotbugi-mcp'));
    await writeStorageConfig(join(state.home, 'Documents', '돋부기'));
    expect(storageRoot()).toBe(join(state.home, 'Documents', '돋부기'));
  });

  it('깨진 설정은 기본 위치로 보되, strict 면 오류', async () => {
    await mkdir(join(state.home, '.config', 'dotbugi-mcp'), { recursive: true });
    await writeFile(storageConfigFile(), JSON.stringify({ version: 1, root: 'relative/path' }));
    expect(storageRoot()).toBe(join(state.home, 'Downloads', 'dotbugi-mcp'));
    expect(() => readStorageConfig(undefined, true)).toThrow('바꾸지 않았습니다');
  });

  it.each(['\u202E', '\u200B'])('경로에 서식 문자(%j)가 있으면 깨진 설정으로 본다', async (ch) => {
    await mkdir(join(state.home, '.config', 'dotbugi-mcp'), { recursive: true });
    await writeFile(storageConfigFile(), JSON.stringify({ version: 1, root: join(state.home, `a${ch}b`) }));
    expect(() => readStorageConfig(undefined, true)).toThrow('바꾸지 않았습니다');
  });
});

describe('moveLegacyDir', () => {
  const root = () => join(state.home, 'root');

  it('예전 폴더를 학기 폴더 아래로 옮긴다', async () => {
    await mkdir(join(root(), '자료구조'), { recursive: true });
    await writeFile(join(root(), '자료구조', 'a.txt'), 'A');
    expect(await moveLegacyDir(join(root(), '자료구조'), join(root(), '2026-2학기', '자료구조'))).toBeNull();
    expect(await readdir(join(root(), '2026-2학기', '자료구조'))).toEqual(['a.txt']);
    expect(await readdir(root())).toEqual(['2026-2학기']);
  });

  it('대상이 있으면 덮어쓰거나 합치지 않고 경고만 한다', async () => {
    await mkdir(join(root(), '자료구조'), { recursive: true });
    await writeFile(join(root(), '자료구조', 'a.txt'), 'A');
    await mkdir(join(root(), '2026-2학기', '자료구조'), { recursive: true });
    expect(await moveLegacyDir(join(root(), '자료구조'), join(root(), '2026-2학기', '자료구조'))).toContain(
      '이미 있습니다'
    );
    expect(await readdir(join(root(), '자료구조'))).toEqual(['a.txt']);
    expect(await readdir(join(root(), '2026-2학기', '자료구조'))).toEqual([]);
  });

  it('링크는 옮기지 않고, 학기 폴더가 링크면 그 너머로 옮기지 않는다', async () => {
    const outside = join(state.home, 'outside');
    await mkdir(outside);
    await mkdir(root());
    await symlink(outside, join(root(), '자료구조'));
    expect(await moveLegacyDir(join(root(), '자료구조'), join(root(), '2026-2학기', '자료구조'))).toBeNull();
    expect((await readdir(root())).sort()).toEqual(['자료구조']);

    await mkdir(join(root(), '운영체제'));
    await symlink(outside, join(root(), '2026-1학기'));
    expect(await moveLegacyDir(join(root(), '운영체제'), join(root(), '2026-1학기', '운영체제'))).toContain('링크');
    expect(await readdir(outside)).toEqual([]);
  });
});

// hs-shell/dotbugi-mcp#165 — WSL 재시작으로 G: 마운트가 풀리면 /mnt/g 는 빈 폴더만 남는다
describe('ensureStorageRoot', () => {
  const defaultRoot = () => join(state.home, 'Downloads', 'dotbugi-mcp');

  it('사용자가 고른 저장 위치가 없으면 만들지 않고(상위 포함) 멈춘다 — 쓰기 경로(ensureRealDir)도 같다', async () => {
    const gone = join(state.home, 'gdrive', '내 드라이브', '돋부기');
    await writeStorageConfig(gone);
    const before = await readdir(state.home, { recursive: true });
    await expect(ensureStorageRoot()).rejects.toThrow(`저장 위치 ${gone} 를 찾을 수 없습니다`);
    await expect(ensureStorageRoot(gone, true)).rejects.toThrow('찾을 수 없습니다');
    await expect(ensureRealDir(gone, join(gone, '2026-2학기', '자료구조'))).rejects.toThrow('찾을 수 없습니다');
    expect(await readdir(state.home, { recursive: true })).toEqual(before);
  });

  it('기본 위치는 처음 쓸 때(create) 만들고, 읽기만 할 때는 없어도 오류 없이 넘어간다', async () => {
    await ensureStorageRoot();
    expect(await readdir(state.home)).toEqual([]);
    await ensureRealDir(defaultRoot(), join(defaultRoot(), '2026-2학기'));
    expect(await readdir(defaultRoot())).toEqual(['2026-2학기']);
  });

  it('있으면 통과, 파일이면 거부한다', async () => {
    const custom = join(state.home, 'mine');
    await mkdir(custom);
    await ensureStorageRoot(custom);
    await writeFile(join(state.home, 'file'), 'x');
    await expect(ensureStorageRoot(join(state.home, 'file'))).rejects.toThrow('폴더가 아닙니다');
  });

  it('WSL 의 Windows 드라이브 경로면 마운트 명령을 안내하고, 아니면 다시 연결·set_storage_dir 를 안내한다', () => {
    state.wsl = true;
    const text = missingStorageRootMessage('/mnt/g/내 드라이브/돋부기');
    expect(text).toContain('Windows 드라이브(G:)');
    expect(text).toContain('! wsl.exe -u root -e sh -c "mkdir -p /mnt/g && mount -t drvfs G: /mnt/g"');
    expect(text).toContain('G: /mnt/g drvfs defaults 0 0');
    expect(missingStorageRootMessage('/home/u/돋부기')).not.toContain('mount');
    state.wsl = false;
    expect(missingStorageRootMessage('/mnt/g/돋부기')).not.toContain('mount');
    expect(missingStorageRootMessage('/mnt/g/돋부기')).toContain('set_storage_dir');
  });
});
