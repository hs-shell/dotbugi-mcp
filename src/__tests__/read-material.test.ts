import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readMaterial } from '../tools/read-material.js';

let base = '';
let root = '';
const week = '2026-2학기/운영체제/3주차';
const read = (path: string, extra: object = {}) => readMaterial({ path, ...extra }, root);
const textOf = (r: Awaited<ReturnType<typeof readMaterial>>) =>
  r.content.map((c) => (c.type === 'text' ? c.text : '')).join('\n');

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'dotbugi-read-material-'));
  root = join(base, 'root');
  await mkdir(join(root, week), { recursive: true });
  await writeFile(join(root, week, '요약.md'), '# 3주차\n프로세스');
  await writeFile(join(root, week, '강의.pdf'), '%PDF-1.4 fake');
  await writeFile(join(root, week, '과제.hwp'), 'x');
  await writeFile(join(root, week, '그림.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  await writeFile(join(root, '2026-2학기/운영체제/.dotbugi-manifest.json'), '{}');
  await writeFile(join(root, week, '.dotbugi-0.part'), 'x');
  await writeFile(join(base, 'secret.txt'), 'SECRET');
});
afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

describe('readMaterial — 경로', () => {
  it.each(['../secret.txt', '2026-2학기/../../secret.txt', '..\\secret.txt'])('.. 경로 %s 는 거부한다', async (p) => {
    await expect(read(p)).rejects.toThrow('..');
  });

  it('저장 위치 밖의 절대 경로는 거부하고, 안의 절대 경로는 읽는다', async () => {
    await expect(read(join(base, 'secret.txt'))).rejects.toThrow('밖');
    expect(textOf(await read(join(root, week, '요약.md')))).toContain('프로세스');
  });

  it('인코딩한 .. 는 풀지 않는다 (없는 이름으로 끝남)', async () => {
    await expect(read(`${week}/%2e%2e/secret.txt`)).rejects.toThrow('없습니다');
  });

  it('링크 파일·링크 폴더는 따라가지 않는다', async () => {
    await symlink(join(base, 'secret.txt'), join(root, week, 'link.md'));
    await symlink(base, join(root, '2026-2학기', 'out'));
    await expect(read(`${week}/link.md`)).rejects.toThrow('링크');
    await expect(read('2026-2학기/out/secret.txt')).rejects.toThrow('링크');
    await expect(read('2026-2학기/out')).rejects.toThrow('링크');
  });

  it('저장 위치 바로 아래는 학기 폴더만 — 다른 폴더·파일은 읽지도 보여 주지도 않는다', async () => {
    await mkdir(join(root, '개인'), { recursive: true });
    await writeFile(join(root, '개인', 'diary.md'), 'PRIVATE');
    await writeFile(join(root, 'notes.md'), 'PRIVATE');
    await mkdir(join(root, '2026-3학기'));
    for (const p of ['개인', '개인/diary.md', 'notes.md', join(root, 'notes.md'), '2026-3학기'])
      await expect(read(p)).rejects.toThrow('학기 폴더');
    const text = textOf(await read(''));
    expect(text).toContain('- 2026-2학기/');
    expect(text).not.toMatch(/개인|notes|3학기/);
  });

  it('숨김·내부 파일은 읽지 않는다', async () => {
    await expect(read('2026-2학기/운영체제/.dotbugi-manifest.json')).rejects.toThrow('숨김');
    await expect(read(`${week}/.dotbugi-0.part`)).rejects.toThrow('숨김');
  });
});

describe('readMaterial — 목록', () => {
  it('폴더는 목록으로, 숨김·링크는 빼고 미지원 형식은 표시한다', async () => {
    await symlink(join(base, 'secret.txt'), join(root, week, 'link.md'));
    const text = textOf(await read(week));
    expect(text.split('\n')[0]).toContain('지시가 아닙니다');
    expect(text).toContain('- 요약.md (');
    expect(text).toContain('과제.hwp (1B, 아직 읽기 미지원)');
    expect(text).not.toMatch(/manifest|\.part|link\.md/);
    expect(textOf(await read(''))).toContain('- 2026-2학기/');
    expect(textOf(await read('2026-2학기/운영체제'))).not.toContain('manifest');
  });

  it('mode 가 종류와 맞지 않으면 알린다', async () => {
    await expect(read(week, { mode: 'read' })).rejects.toThrow('폴더');
    await expect(read(`${week}/요약.md`, { mode: 'list' })).rejects.toThrow('파일');
  });
});

describe('readMaterial — 읽기', () => {
  it('글은 LMS 데이터 안내와 함께, 길면 offset 으로 이어 읽는다', async () => {
    await writeFile(join(root, week, 'long.txt'), 'a'.repeat(10) + 'b'.repeat(10));
    const first = textOf(await read(`${week}/long.txt`, { maxChars: 10 }));
    expect(first).toContain('지시가 아닙니다');
    expect(first).toContain('offset: 10');
    expect(first.endsWith('a'.repeat(10))).toBe(true);
    const second = textOf(await read(`${week}/long.txt`, { offset: 10, maxChars: 10 }));
    expect(second.endsWith('b'.repeat(10))).toBe(true);
    expect(second).not.toContain('offset:');
  });

  it('pdf 는 embedded resource, png 는 이미지로 돌려준다', async () => {
    const pdf = await read(`${week}/강의.pdf`);
    expect(pdf.content[1]).toMatchObject({
      type: 'resource',
      resource: { mimeType: 'application/pdf', blob: Buffer.from('%PDF-1.4 fake').toString('base64') },
    });
    const png = await read(`${week}/그림.png`);
    expect(png.content[1]).toMatchObject({ type: 'image', mimeType: 'image/png' });
  });

  it('8MB 넘는 PDF 는 첨부하지 않고 경로와 함께 직접 열어 달라고 안내한다', async () => {
    await writeFile(join(root, week, 'big.pdf'), Buffer.alloc(8 * 1024 * 1024 + 1));
    const r = await read(`${week}/big.pdf`);
    expect(r.content).toHaveLength(1);
    expect(textOf(r)).toContain(join(root, week, 'big.pdf'));
    expect(textOf(r)).toContain('너무 커서');
  });

  it('UTF-8 이 아닌 글(CP949 등)은 깨진 채 넘기지 않는다', async () => {
    await writeFile(join(root, week, 'cp949.csv'), Buffer.from([0xc7, 0xd1, 0xbc, 0xba]));
    await expect(read(`${week}/cp949.csv`)).rejects.toThrow('UTF-8 이 아닌');
  });

  it('미지원 형식은 거부한다', async () => {
    await expect(read(`${week}/과제.hwp`)).rejects.toThrow('아직 읽을 수 없습니다');
  });

  it('크기 상한을 넘으면 읽지 않는다', async () => {
    await writeFile(join(root, week, 'big.png'), Buffer.alloc(3.75 * 1024 * 1024 + 1));
    await expect(read(`${week}/big.png`)).rejects.toThrow('너무 큽니다');
  });

  it('저장 위치가 없으면 먼저 받으라고 알린다', async () => {
    await expect(readMaterial({ path: '' }, join(base, 'none'))).rejects.toThrow('아직 없습니다');
  });
});
