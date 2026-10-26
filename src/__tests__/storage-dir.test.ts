import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MATERIALS_MANIFEST_NAME } from '../constants.js';
import { defaultStorageRoot, readStorageConfig, semesterOf, storageRoot, writeStorageConfig } from '../storage.js';
import type { Asker } from '../tools/confirm.js';
import { resolveStorageDir, setStorageDir } from '../tools/storage-dir.js';

const state = vi.hoisted(() => ({
  home: '',
  wsl: false,
  localAppData: null as string | null,
  mount: '/mnt/',
  driveRoots: [] as string[],
  // 이 경로 아래에서 나가는 rename 은 다른 드라이브인 것처럼 EXDEV 로 실패시킨다
  exdevFrom: null as string | null,
  // drvfs 처럼 권한 복사가 필요한 fs.copyFile·chmod 를 EPERM 으로 거부한다
  drvfs: false,
}));
vi.mock('node:os', async (orig) => {
  const os = await orig<typeof import('node:os')>();
  return { ...os, homedir: () => state.home, userInfo: () => ({ ...os.userInfo(), homedir: state.home }) };
});
vi.mock('node:fs/promises', async (orig) => {
  const fs = await orig<typeof import('node:fs/promises')>();
  return {
    ...fs,
    rename: async (from: string, to: string) => {
      if (state.exdevFrom && from.startsWith(state.exdevFrom))
        throw Object.assign(new Error('cross-device link not permitted'), { code: 'EXDEV' });
      return fs.rename(from, to);
    },
    copyFile: async (...a: Parameters<typeof fs.copyFile>) => {
      if (state.drvfs) throw Object.assign(new Error('operation not permitted, copyfile'), { code: 'EPERM' });
      return fs.copyFile(...a);
    },
  };
});
vi.mock('../drive.js', async (orig) => ({
  ...(await orig<typeof import('../drive.js')>()),
  detectGoogleDrive: () => ({ roots: state.driveRoots, unmounted: [] }),
}));
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
  state.localAppData = null;
  state.driveRoots = [];
  state.exdevFrom = null;
  state.drvfs = false;
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
    ['~/a\nb', '서식 문자'],
    ['~/a\u202Ecod.exe', '서식 문자'],
    ['~/a\u200Bb', '서식 문자'],
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
    // '..' 로 올라가거나 금지 문자가 있는 Windows 경로는 변환하지 않는다
    for (const bad of ['C:\\Users\\u\\..\\..\\Windows', 'C:\\Users\\u\\a|b'])
      await expect(resolveStorageDir(bad)).rejects.toThrow('Windows 경로 형식');
    await rm(mnt, { recursive: true, force: true });
  });

  it('Google Drive "내 드라이브" 아래는 받고, 공유 드라이브·Drive 루트 자체는 거부한다', async () => {
    const drive = await mkdtemp(join(tmpdir(), 'dotbugi-drive-'));
    await mkdir(join(drive, '내 드라이브'));
    state.driveRoots = [join(drive, '내 드라이브')];
    expect((await resolveStorageDir(join(drive, '내 드라이브', '돋부기'))).path).toBe(
      join(drive, '내 드라이브', '돋부기')
    );
    await expect(resolveStorageDir(join(drive, '공유 드라이브', '팀'))).rejects.toThrow('홈 폴더');
    await expect(resolveStorageDir(join(drive, '내 드라이브'))).rejects.toThrow('홈 폴더');
    await expect(resolveStorageDir(join(drive, '내 드라이브', '.x'))).rejects.toThrow('숨김');
    await rm(drive, { recursive: true, force: true });
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

  it('지금과 같은 위치면 묻지 않고 그대로 둔다', async () => {
    await writeStorageConfig(home('Documents', '돋부기'));
    await mkdir(home('Documents', '돋부기'), { recursive: true });
    const a = asker(true);
    expect(await setStorageDir({ path: '~/Documents/돋부기/' }, a)).toBe(
      `이미 저장 위치가 ${home('Documents', '돋부기')} 입니다.`
    );
    expect(a.asked).toEqual([]);
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
    await writeFile(home('Documents', '돋부기', 'assign-5', 'b.txt'), 'B');
    const text = await setStorageDir({ path: '~/Documents/돋부기' }, asker(true));
    expect(text).toContain('옮긴 항목 1개');
    expect(text).toContain('같은 이름이 있어 그대로 둠');
    expect(await readdir(oldRoot())).toEqual(['assign-5']);
  });

  it('저장 위치의 dotbugi 자료만 옮기고 개인 파일·다른 폴더는 그대로 둔다', async () => {
    // 저장 위치가 ~/Downloads 처럼 넓은 폴더인 경우
    await writeStorageConfig(home('Downloads'));
    const dl = (...p: string[]) => home('Downloads', ...p);
    await mkdir(dl('2026-2학기'), { recursive: true });
    await mkdir(dl('assign-7'));
    await mkdir(dl('자료구조'));
    await writeFile(dl('자료구조', MATERIALS_MANIFEST_NAME), JSON.stringify({ version: 1, courseId: '1', files: [] }));
    // manifest 형식이 틀린 폴더·이름만 비슷한 폴더·링크·개인 파일은 dotbugi 자료가 아니다
    await mkdir(dl('가짜과목'));
    await writeFile(dl('가짜과목', MATERIALS_MANIFEST_NAME), '{}');
    await mkdir(dl('assign-x'));
    await symlink(dl('2026-2학기'), dl('2026-1학기'));
    await writeFile(dl('사진.jpg'), 'P');
    const a = asker(true);
    const text = await setStorageDir({ path: '~/Documents/돋부기' }, a);
    expect(a.asked[0]).toContain('dotbugi 자료 3개');
    expect(a.asked[0]).toContain('아닌 항목 4개');
    expect(a.asked[0]).not.toContain('사진.jpg');
    expect(text).toContain('옮긴 항목 3개');
    expect(text).toContain('옮기지 않은 항목 4개 (dotbugi 자료가 아님)');
    expect((await readdir(home('Documents', '돋부기'))).sort()).toEqual(['2026-2학기', 'assign-7', '자료구조'].sort());
    expect((await readdir(dl())).sort()).toEqual(['2026-1학기', 'assign-x', '가짜과목', '사진.jpg'].sort());
  });

  it('다른 드라이브면 복사·검증한 뒤 새 위치를 저장하고 원본을 지운다', async () => {
    await seed();
    state.exdevFrom = oldRoot();
    const text = await setStorageDir({ path: '~/Documents/돋부기' }, asker(true));
    expect(text).toContain('옮긴 항목 2개');
    const to = home('Documents', '돋부기');
    expect((await readdir(to)).sort()).toEqual(['2026-2학기', 'assign-5']);
    expect(await readFile(join(to, '2026-2학기', '자료구조', 'a.txt'), 'utf8')).toBe('A');
    expect(await readdir(home('Downloads'))).toEqual([]);
    expect(storageRoot()).toBe(to);
  });

  it('지난번 복사가 원본 삭제 전에 끊겼으면 같은 내용을 옮긴 것으로 보고 원본만 지운다 (남은 임시 폴더도 정리)', async () => {
    await seed();
    const to = home('Documents', '돋부기');
    await mkdir(join(to, '2026-2학기', '자료구조'), { recursive: true });
    await writeFile(join(to, '2026-2학기', '자료구조', 'a.txt'), 'A');
    // assign-5 는 복사 도중 끊겨 임시 폴더만 남은 상태
    await mkdir(join(to, '.dotbugi-moving-assign-5', 'half'), { recursive: true });
    state.exdevFrom = oldRoot();
    const text = await setStorageDir({ path: '~/Documents/돋부기' }, asker(true));
    expect(text).toContain('옮긴 항목 2개');
    expect((await readdir(to)).sort()).toEqual(['2026-2학기', 'assign-5']);
    expect(await readdir(home('Downloads'))).toEqual([]);
  });

  it('다른 드라이브로 옮길 항목에 링크가 있으면 그 항목은 원본 그대로 두고 임시 폴더도 남기지 않는다', async () => {
    await seed();
    await symlink(join(oldRoot(), '2026-2학기', '자료구조', 'a.txt'), join(oldRoot(), 'assign-5', 'link'));
    state.exdevFrom = oldRoot();
    const text = await setStorageDir({ path: '~/Documents/돋부기' }, asker(true));
    expect(text).toContain('옮긴 항목 1개');
    expect(text).toContain('링크');
    expect(await readdir(home('Documents', '돋부기'))).toEqual(['2026-2학기']);
    expect(await readdir(join(oldRoot(), 'assign-5'))).toEqual(['link']);
  });

  it('지금 위치와 이름만 다른 같은 폴더(상위 링크·대소문자)면 "같은 내용" 으로 보고 지우지 않는다', async () => {
    // 설정의 옛 위치가 링크를 거쳐 새 위치와 같은 폴더를 가리키는 경우 — 대소문자 무시 파일 시스템의 ~/downloads 와 같은 상황
    const real = home('Documents', '돋부기');
    await mkdir(join(real, 'assign-5'), { recursive: true });
    await writeFile(join(real, 'assign-5', 'a.txt'), 'A');
    await symlink(home('Documents'), home('alias'));
    await writeStorageConfig(home('alias', '돋부기'));
    const text = await setStorageDir({ path: '~/Documents/돋부기' }, asker(true));
    expect(text).toContain('같은 이름이 있어 그대로 둠');
    expect(await readFile(join(real, 'assign-5', 'a.txt'), 'utf8')).toBe('A');
  });

  it('권한 복사를 거부하는 드라이브(WSL drvfs)로도 내용 복사·검증으로 옮긴다', async () => {
    await seed();
    state.exdevFrom = oldRoot();
    state.drvfs = true;
    const to = home('Documents', '돋부기');
    const text = await setStorageDir({ path: '~/Documents/돋부기' }, asker(true));
    expect(text).toContain('옮긴 항목 2개');
    expect(text).not.toContain('EPERM');
    expect(await readFile(join(to, '2026-2학기', '자료구조', 'a.txt'), 'utf8')).toBe('A');
    expect(readStorageConfig()).toEqual({ version: 1, root: to });
  });

  it('일부를 옮기지 못했으면 같은 경로로 다시 부를 때 남은 항목을 이어서 옮긴다', async () => {
    await seed();
    state.exdevFrom = oldRoot();
    const to = home('Documents', '돋부기');
    await writeFile(join(oldRoot(), 'assign-5', 'b.txt'), 'B');
    // 링크가 든 항목은 복사하지 않는다 → 첫 호출에서 실패로 남는다
    await symlink(home(), join(oldRoot(), 'assign-5', 'link'));
    const first = await setStorageDir({ path: '~/Documents/돋부기' }, asker(true));
    expect(first).toContain('이어서 옮깁니다');
    expect(readStorageConfig()).toEqual({ version: 1, root: to, movedFrom: oldRoot() });
    await rm(join(oldRoot(), 'assign-5', 'link'));
    const a = asker(true);
    const second = await setStorageDir({ path: '~/Documents/돋부기' }, a);
    expect(a.asked).toHaveLength(1);
    expect(second).toContain('옮긴 항목 1개');
    expect(await readFile(join(to, 'assign-5', 'b.txt'), 'utf8')).toBe('B');
    expect(readStorageConfig()).toEqual({ version: 1, root: to });
  });

  it('새 위치 저장 뒤·원본 삭제 전에 끊겼으면 같은 경로로 다시 부를 때 승인받고 남은 원본을 지운다', async () => {
    await seed();
    const to = home('Documents', '돋부기');
    await mkdir(join(to, '2026-2학기', '자료구조'), { recursive: true });
    await writeFile(join(to, '2026-2학기', '자료구조', 'a.txt'), 'A');
    await mkdir(join(to, 'assign-5'));
    // 끊긴 상태: 새 위치는 저장됐고 옛 위치가 movedFrom 으로 남음. 옛 위치의 개인 파일은 지우지 않아야 한다
    await writeFile(join(oldRoot(), 'mine.txt'), 'X');
    await writeStorageConfig(to, undefined, oldRoot());
    const no = asker(false);
    await setStorageDir({ path: '~/Documents/돋부기' }, no);
    expect(no.asked).toHaveLength(1);
    expect((await readdir(oldRoot())).sort()).toEqual(['2026-2학기', 'assign-5', 'mine.txt']);
    const text = await setStorageDir({ path: '~/Documents/돋부기' }, asker(true));
    expect(text).toContain('옮긴 항목 2개');
    expect(await readdir(oldRoot())).toEqual(['mine.txt']);
    expect(await readFile(join(to, '2026-2학기', '자료구조', 'a.txt'), 'utf8')).toBe('A');
    expect(readStorageConfig()).toEqual({ version: 1, root: to });
  });

  it('남은 원본이 새 위치와 내용이 다르면 지우지 않고 묻지도 않는다', async () => {
    await seed();
    const to = home('Documents', '돋부기');
    await mkdir(join(to, '2026-2학기', '자료구조'), { recursive: true });
    await writeFile(join(to, '2026-2학기', '자료구조', 'a.txt'), 'changed');
    // 내용이 다른 항목만 남은 경우 (새 위치에 없는 항목은 이어서 옮기는 대상이라 뺀다)
    await rm(join(oldRoot(), 'assign-5'), { recursive: true });
    await writeStorageConfig(to, undefined, oldRoot());
    const a = asker(true);
    expect(await setStorageDir({ path: '~/Documents/돋부기' }, a)).toContain('이미 저장 위치가');
    expect(a.asked).toHaveLength(0);
    expect(await readFile(join(oldRoot(), '2026-2학기', '자료구조', 'a.txt'), 'utf8')).toBe('A');
  });

  // hs-shell/dotbugi-mcp#165 — 지금 위치(Drive 등)의 연결이 끊긴 경우
  it('지금 위치가 사라졌으면 승인 창에 알리고, 옛 위치는 만들지 않은 채 위치만 바꾼다', async () => {
    const gone = home('gdrive', '돋부기');
    await writeStorageConfig(gone);
    const a = asker(true);
    expect(await setStorageDir({ path: '~/Documents/돋부기' }, a)).toContain('저장 위치를');
    expect(a.asked[0]).toContain(`지금 위치 ${gone} 를 찾을 수 없어`);
    expect(storageRoot()).toBe(home('Documents', '돋부기'));
    expect(await readdir(state.home)).not.toContain('gdrive');
  });

  it('이어서 옮길 옛 위치가 사라졌으면 movedFrom 을 지우지 않고 멈춘다', async () => {
    const to = home('Documents', '돋부기');
    const gone = home('gdrive', '돋부기');
    await mkdir(to, { recursive: true });
    await writeStorageConfig(to, undefined, gone);
    const a = asker(true);
    await expect(setStorageDir({ path: '~/Documents/돋부기' }, a)).rejects.toThrow(
      `저장 위치 ${gone} 를 찾을 수 없습니다`
    );
    expect(a.asked).toHaveLength(0);
    expect(readStorageConfig()).toEqual({ version: 1, root: to, movedFrom: gone });
  });

  it('지금 위치의 안쪽·상위 폴더는 거부한다', async () => {
    await writeStorageConfig(home('Documents', '돋부기'));
    await expect(setStorageDir({ path: '~/Documents/돋부기/sub' }, asker(true))).rejects.toThrow('안쪽이나 상위');
    await expect(setStorageDir({ path: '~/Documents' }, asker(true))).rejects.toThrow('안쪽이나 상위');
    expect(storageRoot()).toBe(home('Documents', '돋부기'));
  });
});

describe('WSL 기본 저장 위치', () => {
  it('WSL 이면 Windows 다운로드 폴더, 단 WSL 안에 받아 둔 자료가 있으면 그대로', async () => {
    const mnt = await mkdtemp(join(tmpdir(), 'dotbugi-mnt-'));
    state.wsl = true;
    state.localAppData = join(mnt, 'c', 'Users', 'u', 'AppData', 'Local');
    expect(defaultStorageRoot()).toBe(join(mnt, 'c', 'Users', 'u', 'Downloads', 'dotbugi-mcp'));
    // 다음 실행에서 Windows 조회가 실패해도 갈라지지 않게 설정에 고정된다
    expect(storageRoot()).toBe(join(mnt, 'c', 'Users', 'u', 'Downloads', 'dotbugi-mcp'));
    await mkdir(home('Downloads', 'dotbugi-mcp'), { recursive: true });
    expect(defaultStorageRoot()).toBe(home('Downloads', 'dotbugi-mcp'));
    await rm(mnt, { recursive: true, force: true });
  });

  it('Windows 사용자 폴더를 못 찾으면 WSL 안 기본값', () => {
    state.wsl = true;
    expect(defaultStorageRoot()).toBe(home('Downloads', 'dotbugi-mcp'));
  });
});
