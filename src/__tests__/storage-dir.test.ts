import { mkdir, mkdtemp, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readStorageConfig, semesterOf, storageRoot, writeStorageConfig } from '../storage.js';
import type { Asker } from '../tools/confirm.js';
import { resolveStorageDir, setStorageDir } from '../tools/storage-dir.js';

const state = vi.hoisted(() => ({ home: '', wsl: false, localAppData: null as string | null, mount: '/mnt/' }));
vi.mock('node:os', async (orig) => ({ ...(await orig<typeof import('node:os')>()), homedir: () => state.home }));
vi.mock('../platform.js', () => ({ isWsl: () => state.wsl }));
vi.mock('../wsl-paths.js', async (orig) => ({
  ...(await orig<typeof import('../wsl-paths.js')>()),
  wslLocalAppData: () => state.localAppData,
  wslAutomountRoot: () => state.mount,
}));

const home = (...p: string[]) => join(state.home, ...p);
const asker = (confirm: boolean): Asker & { asked: string[] } => {
  const asked: string[] = [];
  return {
    asked,
    caps: { elicitation: { form: {} } },
    elicit: async (params) => {
      asked.push(params.message);
      return { action: 'accept', content: { confirm } };
    },
  };
};

beforeEach(async () => {
  state.home = await mkdtemp(join(tmpdir(), 'dotbugi-storage-dir-'));
  state.wsl = false;
});
afterEach(async () => {
  await rm(state.home, { recursive: true, force: true });
});

describe('resolveStorageDir', () => {
  it('~ 를 풀고 홈 아래 경로를 정규화한다', async () => {
    expect((await resolveStorageDir('~/Documents/돋부기')).path).toBe(home('Documents', '돋부기'));
    expect((await resolveStorageDir(`${home('a')}/../b`)).path).toBe(home('b'));
  });

  it.each([
    ['relative/x', '절대 경로'],
    ['/etc/dotbugi', '홈 폴더'],
    ['~', '홈 폴더'],
    ['~/../other', '홈 폴더'],
    ['~/.config/x', '숨김'],
    ['~/Documents/.ssh', '숨김'],
    ['~/Library/x', '시스템'],
    ['~/a\nb', '제어 문자'],
    ['~/APPDAT~1/x', '짧은 이름'],
    ['~/AppData./x', '점·공백'],
    ['~/Documents/돋부기 ', '점·공백'],
  ])('%j 는 거부한다', async (input, message) => {
    await expect(resolveStorageDir(input)).rejects.toThrow(message);
  });

  it('경로 중간이 링크면 거부한다', async () => {
    await mkdir(home('real'));
    await symlink(home('real'), home('link'));
    await expect(resolveStorageDir('~/link/돋부기')).rejects.toThrow('링크');
  });

  it('WSL 이면 C:\\Users\\<사용자> 아래 경로를 받는다 (AppData 는 거부)', async () => {
    // Windows 드라이브는 Linux 홈 밖에 있다
    const mnt = await mkdtemp(join(tmpdir(), 'dotbugi-mnt-'));
    state.wsl = true;
    state.mount = `${mnt}/`;
    state.localAppData = join(mnt, 'c', 'Users', 'u', 'AppData', 'Local');
    expect((await resolveStorageDir('C:\\Users\\u\\Documents\\돋부기')).path).toBe(
      join(mnt, 'c', 'Users', 'u', 'Documents', '돋부기')
    );
    await expect(resolveStorageDir('C:\\Users\\u\\AppData\\x')).rejects.toThrow('시스템');
    await expect(resolveStorageDir('C:\\Users\\other\\x')).rejects.toThrow('홈 폴더');
    await expect(resolveStorageDir('C:\\Users\\u')).rejects.toThrow('홈 폴더');
    await rm(mnt, { recursive: true, force: true });
  });
});

describe('setStorageDir', () => {
  const oldRoot = () => home('Downloads', 'dotbugi-mcp');
  const seed = async () => {
    await mkdir(join(oldRoot(), '2026-2학기', '자료구조'), { recursive: true });
    await writeFile(join(oldRoot(), '2026-2학기', '자료구조', 'a.txt'), 'A');
    await mkdir(join(oldRoot(), 'assign-5'));
  };

  it('승인하면 기존 자료를 옮기고 새 위치를 저장한다', async () => {
    await seed();
    const a = asker(true);
    const text = await setStorageDir({ path: '~/Documents/돋부기' }, a);
    expect(a.asked[0]).toContain(`${oldRoot()} → ${home('Documents', '돋부기')}`);
    expect(a.asked[0]).toContain('2개');
    expect(text).toContain('옮긴 항목 2개');
    expect(text).toContain(join(home('Documents', '돋부기'), semesterOf(new Date())));
    expect((await readdir(home('Documents', '돋부기'))).sort()).toEqual(['2026-2학기', 'assign-5']);
    expect(await readdir(home('Downloads'))).toEqual([]);
    expect(storageRoot()).toBe(home('Documents', '돋부기'));
  });

  it('승인하지 않으면 아무것도 옮기지도 저장하지도 않는다', async () => {
    await seed();
    expect(await setStorageDir({ path: '~/Documents/돋부기' }, asker(false))).toContain('아무것도 옮기지 않았습니다');
    expect((await readdir(oldRoot())).sort()).toEqual(['2026-2학기', 'assign-5']);
    expect(readStorageConfig()).toBeNull();
  });

  it('moveExisting=false 여도 위치 변경 자체를 승인받고, 기존 자료는 그대로 둔다', async () => {
    await seed();
    const a = asker(true);
    expect(await setStorageDir({ path: '~/Documents/돋부기', moveExisting: false }, a)).toContain('그대로 있습니다');
    expect(a.asked[0]).toContain(`${oldRoot()} → ${home('Documents', '돋부기')}`);
    expect(a.asked[0]).toContain('앞으로 받는 LMS 파일이 여기 저장됩니다');
    expect((await readdir(oldRoot())).sort()).toEqual(['2026-2학기', 'assign-5']);
    expect(storageRoot()).toBe(home('Documents', '돋부기'));
  });

  it('옮길 자료가 없어도 승인하지 않으면 위치를 바꾸지 않는다', async () => {
    expect(await setStorageDir({ path: '~/Documents/돋부기' }, asker(false))).toContain(
      '저장 위치를 바꾸지 않았습니다'
    );
    expect(readStorageConfig()).toBeNull();
  });

  it('확인 창이 없으면 토큰을 주고, 그 토큰으로 다시 불러야만 바꾼다', async () => {
    const noForm: Asker = { caps: {}, elicit: async () => ({ action: 'cancel' }) };
    const first = await setStorageDir({ path: '~/Documents/돋부기' }, noForm);
    expect(readStorageConfig()).toBeNull();
    const token = /confirmToken: "([0-9a-f]+)"/.exec(first)![1];
    // 다른 경로에는 쓸 수 없다
    expect(await setStorageDir({ path: '~/Documents/other', confirmToken: token }, noForm)).toContain(
      '바꾸지 않았습니다'
    );
    const again = /confirmToken: "([0-9a-f]+)"/.exec(await setStorageDir({ path: '~/Documents/돋부기' }, noForm))![1];
    expect(await setStorageDir({ path: '~/Documents/돋부기', confirmToken: again }, noForm)).toContain('바꿨습니다');
    expect(storageRoot()).toBe(home('Documents', '돋부기'));
  });

  it('새 위치에 같은 이름이 있으면 덮어쓰지 않고 남겨 둔다', async () => {
    await seed();
    await mkdir(home('Documents', '돋부기', 'assign-5'), { recursive: true });
    const text = await setStorageDir({ path: '~/Documents/돋부기' }, asker(true));
    expect(text).toContain('옮긴 항목 1개');
    expect(text).toContain('같은 이름이 있어 그대로 둠');
    expect(await readdir(oldRoot())).toEqual(['assign-5']);
  });

  it('지금 위치의 안쪽·상위 폴더는 거부한다', async () => {
    await writeStorageConfig(home('Documents', '돋부기'));
    await expect(setStorageDir({ path: '~/Documents/돋부기/sub' }, asker(true))).rejects.toThrow('안쪽이나 상위');
    await expect(setStorageDir({ path: '~/Documents' }, asker(true))).rejects.toThrow('안쪽이나 상위');
    expect(storageRoot()).toBe(home('Documents', '돋부기'));
  });
});
