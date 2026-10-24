import { mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MATERIALS_MANIFEST_MAX_BYTES, MATERIALS_MANIFEST_NAME } from '../constants.js';
import { readManifest, resolveInside, writeManifest, type ManifestEntry } from '../materials/manifest.js';

const ENTRY: ManifestEntry = {
  key: 'r:50',
  cmid: 50,
  url: 'https://learn.hansung.ac.kr/pluginfile.php/50/mod_resource/content/3/slides.pdf',
  sha256: 'a'.repeat(64),
  path: '1주차/slides.pdf',
  downloadedAt: '2026-03-02T01:02:03.000Z',
};
const valid = (files: unknown[] = [ENTRY]) => ({ version: 1, courseId: '100', files });

let dir: string;
const file = () => join(dir, MATERIALS_MANIFEST_NAME);
const put = (data: unknown) => writeFile(file(), typeof data === 'string' ? data : JSON.stringify(data));

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'dotbugi-manifest-'));
});
afterEach(() => rm(dir, { recursive: true, force: true }));

describe('readManifest', () => {
  it('없으면 null', async () => {
    expect(await readManifest(dir)).toBeNull();
  });

  it('올바른 기록은 key 로 묶어 돌려준다', async () => {
    await put(valid());
    const m = await readManifest(dir);
    expect(m?.courseId).toBe('100');
    expect([...m!.files.entries()]).toEqual([[ENTRY.key, ENTRY]]);
  });

  it('같은 key 가 두 번 나오면 하나만 남는다 (뒤의 것)', async () => {
    await put(valid([ENTRY, { ...ENTRY, path: 'other.pdf' }]));
    const m = await readManifest(dir);
    expect(m?.files.size).toBe(1);
    expect(m?.files.get(ENTRY.key)?.path).toBe('other.pdf');
  });

  it.each<[string, unknown]>([
    ['깨진 JSON', '{"version":1,'],
    ['JSON 이 아닌 글', 'hello'],
    ['배열', '[]'],
    ['null', 'null'],
    ['다른 version', { ...valid(), version: 2 }],
    ['version 없음', { courseId: '100', files: [] }],
    ['숫자가 아닌 courseId', { ...valid(), courseId: '../100' }],
    ['숫자 courseId', { ...valid(), courseId: 100 }],
    ['files 가 객체', { ...valid(), files: { [ENTRY.key]: ENTRY } }],
    ['__proto__ 만 든 항목', valid([{ key: '__proto__' }])],
    ['빈 key', valid([{ ...ENTRY, key: '' }])],
    ['문자열 cmid', valid([{ ...ENTRY, cmid: '50' }])],
    ['음수 cmid', valid([{ ...ENTRY, cmid: -1 }])],
    ['소수 cmid', valid([{ ...ENTRY, cmid: 1.5 }])],
    ['대문자 sha256', valid([{ ...ENTRY, sha256: 'A'.repeat(64) }])],
    ['짧은 sha256', valid([{ ...ENTRY, sha256: 'a'.repeat(63) }])],
    [
      '다른 출처 url',
      valid([{ ...ENTRY, url: 'https://evil.example/pluginfile.php/50/mod_resource/content/3/a.pdf' }]),
    ],
    ['http url', valid([{ ...ENTRY, url: ENTRY.url.replace('https:', 'http:') }])],
    ['쿼리 붙은 url', valid([{ ...ENTRY, url: `${ENTRY.url}?forcedownload=1` }])],
    ['해시 붙은 url', valid([{ ...ENTRY, url: `${ENTRY.url}#x` }])],
    ['사용자 정보 붙은 url', valid([{ ...ENTRY, url: ENTRY.url.replace('https://', 'https://u:p@') }])],
    [
      '강의자료가 아닌 pluginfile',
      valid([{ ...ENTRY, url: 'https://learn.hansung.ac.kr/pluginfile.php/50/user/icon/f1' }]),
    ],
    ['url 이 아님', valid([{ ...ENTRY, url: 'not a url' }])],
    ['빈 path', valid([{ ...ENTRY, path: '' }])],
    ['너무 긴 path', valid([{ ...ENTRY, path: 'a'.repeat(1025) }])],
    ['숫자 path', valid([{ ...ENTRY, path: 1 }])],
    ['날짜가 아닌 downloadedAt', valid([{ ...ENTRY, downloadedAt: 'yesterday' }])],
    ['문자열 keep', valid([{ ...ENTRY, keep: 'true' }])],
  ])('형식 오류는 경로를 알리는 오류로: %s', async (_, data) => {
    await put(data);
    await expect(readManifest(dir)).rejects.toThrow(file());
  });

  it('상한보다 크면 읽지 않고 오류', async () => {
    await put(' '.repeat(MATERIALS_MANIFEST_MAX_BYTES - 100) + JSON.stringify(valid()) + ' '.repeat(200));
    await expect(readManifest(dir)).rejects.toThrow(file());
  });

  it('정규 파일이 아니면(폴더) 오류', async () => {
    await mkdir(file());
    await expect(readManifest(dir)).rejects.toThrow(file());
  });

  // 링크를 따라가면 폴더 밖 파일을 기록으로 믿게 된다 (O_NOFOLLOW). Windows 는 링크 생성 권한이 없을 수 있어 건너뛴다
  it.skipIf(process.platform === 'win32')('링크면 대상이 올바른 기록이어도 오류', async () => {
    const target = join(dir, 'real.json');
    await writeFile(target, JSON.stringify(valid()));
    await symlink(target, file());
    await expect(readManifest(dir)).rejects.toThrow(file());
  });

  // path 는 형식만 본다 — 폴더 밖 여부는 쓸 때·지울 때 resolveInside 가 다시 확인한다
  it('폴더 밖을 가리키는 path 도 읽기는 하되 resolveInside 가 거른다', async () => {
    await put(valid([{ ...ENTRY, path: '../../etc/passwd' }]));
    const m = await readManifest(dir);
    expect(resolveInside(dir, m!.files.get(ENTRY.key)!.path)).toBeNull();
  });
});

describe('resolveInside', () => {
  it.each(['a.pdf', '1주차/a.pdf', 'a/../b.pdf', './a.pdf', '..a.pdf'])('과목 폴더 안이면 절대 경로: %s', (rel) => {
    const abs = resolveInside(dir, rel);
    expect(abs).toBe(resolve(dir, rel));
  });

  it.each(['', '.', '..', '../x', 'a/../../x', MATERIALS_MANIFEST_NAME, `./sub/../${MATERIALS_MANIFEST_NAME}`])(
    '폴더 자체·밖·manifest 는 null: %s',
    (rel) => {
      expect(resolveInside(dir, rel)).toBeNull();
    }
  );

  it('절대 경로는 null', () => {
    expect(resolveInside(dir, resolve(dir, '..', 'x'))).toBeNull();
    expect(resolveInside(dir, tmpdir())).toBeNull();
  });

  it('역슬래시: Windows 에선 구분자라 밖이면 null, POSIX 에선 파일 이름의 글자라 폴더 안', () => {
    const abs = resolveInside(dir, '..\\..\\x');
    if (process.platform === 'win32') expect(abs).toBeNull();
    else expect(abs).toBe(join(dir, '..\\..\\x'));
  });
});

describe('writeManifest', () => {
  const manifest = { courseId: '100', files: new Map([[ENTRY.key, ENTRY]]) };

  it('읽은 값 그대로 돌아오고 임시 파일을 남기지 않는다', async () => {
    const sub = join(dir, 'new-course');
    await writeManifest(sub, manifest);
    expect(await readManifest(sub)).toEqual(manifest);
    expect(await readdir(sub)).toEqual([MATERIALS_MANIFEST_NAME]);
    expect(JSON.parse(await readFile(join(sub, MATERIALS_MANIFEST_NAME), 'utf8'))).toEqual(valid());
  });

  it.skipIf(process.platform === 'win32')('0600 으로 쓴다', async () => {
    await writeManifest(dir, manifest);
    expect((await stat(file())).mode & 0o777).toBe(0o600);
  });

  it('형식에 맞지 않는 항목은 쓰지 않는다 (기존 기록 유지)', async () => {
    await put(valid());
    const bad = { courseId: '100', files: new Map([[ENTRY.key, { ...ENTRY, sha256: 'x' }]]) };
    await expect(writeManifest(dir, bad)).rejects.toThrow();
    expect(JSON.parse(await readFile(file(), 'utf8'))).toEqual(valid());
    expect(await readdir(dir)).toEqual([MATERIALS_MANIFEST_NAME]);
  });

  it.skipIf(process.platform === 'win32')('기존 manifest 가 링크여도 대상 파일을 덮어쓰지 않는다', async () => {
    const target = join(dir, 'outside.json');
    await writeFile(target, 'untouched');
    await symlink(target, file());
    await writeManifest(dir, manifest);
    expect(await readFile(target, 'utf8')).toBe('untouched');
    expect(await readManifest(dir)).toEqual(manifest);
  });
});
