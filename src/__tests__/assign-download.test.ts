import { lutimes, mkdtemp, readdir, readFile, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { attachmentName, safeFileName, saveAttachment } from '../assign/download.js';

describe('safeFileName', () => {
  it.each([
    ['../../etc/passwd', '_.._etc_passwd'],
    ['..', 'attachment'],
    ['..\\..\\boot.ini', '_.._boot.ini'],
    ['C:\\Windows\\x.dll', 'C__Windows_x.dll'],
    ['.bashrc', 'bashrc'],
    ['CON.txt', '_CON.txt'],
    ['nul .txt', '_nul.txt'],
    ['CON .tar.gz', '_CON .tar.gz'],
    ['CONIN$', '_CONIN$'],
    ['conout$.log', '_conout$.log'],
    ['COM¹.txt', '_COM¹.txt'],
    ['LPT³', '_LPT³'],
    ['COM10.txt', 'COM10.txt'],
    ['과제\u202Efdp.exe', '과제_fdp.exe'],
    ['a\nb\u0000c.pdf', 'a_b_c.pdf'],
    ['보고서 양식.hwp ', '보고서 양식.hwp'],
  ])('%j → %j', (raw, safe) => {
    expect(safeFileName(raw)).toBe(safe);
  });

  it('긴 이름은 확장자를 남기고 줄인다', () => {
    const name = safeFileName(`${'가'.repeat(200)}.pdf`);
    expect(name).toBe(`${'가'.repeat(60)}.pdf`);
    expect(Buffer.byteLength(name)).toBeLessThan(255);
  });

  it('확장자 없는 이름은 자른 뒤 끝의 점·공백을 지운다', () => {
    expect(safeFileName(`${'가'.repeat(59)}. 나머지`)).toBe('가'.repeat(59));
  });
});

describe('attachmentName', () => {
  it('인코딩된 경로 문자도 풀어서 지운다', () => {
    const url = new URL('https://learn.hansung.ac.kr/pluginfile.php/1/mod_assign/introattachment/0/..%2F..%2Fevil.sh');
    expect(attachmentName(url)).toBe('_.._evil.sh');
    expect(attachmentName(new URL('https://learn.hansung.ac.kr/pluginfile.php/1/a/%E0%A4%A.pdf'))).toBe('%E0%A4%A.pdf');
  });
});

describe('saveAttachment', () => {
  const SESSION = 'abcdefghij0123456789';
  const URL_ = new URL('https://learn.hansung.ac.kr/pluginfile.php/1/mod_assign/introattachment/0/a.pdf');
  const fetchMock = vi.fn<typeof fetch>();
  vi.stubGlobal('fetch', fetchMock);
  const STALE = '.dotbugi-00000000-0000-0000-0000-000000000000.part';
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'dotbugi-dl-'));
  });
  afterEach(async () => {
    fetchMock.mockReset();
    await rm(dir, { recursive: true, force: true });
  });

  // 첫 조각을 보낸 뒤 멈춰, 받는 중인 폴더 상태를 볼 수 있게 한다
  function pausedBody() {
    let ctrl!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        ctrl = c;
        c.enqueue(new TextEncoder().encode('par'));
      },
    });
    fetchMock.mockResolvedValue(new Response(body));
    return ctrl;
  }

  it('받는 동안에는 최종 이름이 보이지 않고, 다 받은 뒤 옮긴다', async () => {
    const ctrl = pausedBody();
    const saving = saveAttachment(URL_, dir, 'a.pdf', SESSION);
    await vi.waitFor(async () => expect(await readdir(dir)).toEqual([expect.stringMatching(/^\.dotbugi-.+\.part$/)]));
    ctrl.enqueue(new TextEncoder().encode('t'));
    ctrl.close();
    expect(await saving).toMatchObject({ name: 'a.pdf', path: join(dir, 'a.pdf') });
    expect(await readdir(dir)).toEqual(['a.pdf']);
    expect(await readFile(join(dir, 'a.pdf'), 'utf8')).toBe('part');
  });

  it('받다가 실패하면 임시 파일도 최종 파일도 남기지 않는다', async () => {
    pausedBody().error(new Error('끊김'));
    await expect(saveAttachment(URL_, dir, 'a.pdf', SESSION)).rejects.toThrow('끊김');
    expect(await readdir(dir)).toEqual([]);
  });

  it('같은 이름이 있으면 덮어쓰지 않고 번호를 붙인다', async () => {
    await writeFile(join(dir, 'a.pdf'), '기존');
    fetchMock.mockResolvedValue(new Response('새것'));
    expect(await saveAttachment(URL_, dir, 'a.pdf', SESSION)).toMatchObject({ name: 'a (2).pdf' });
    expect(await readFile(join(dir, 'a.pdf'), 'utf8')).toBe('기존');
    expect(await readFile(join(dir, 'a (2).pdf'), 'utf8')).toBe('새것');
  });

  it('이전 실행이 남긴 오래된 임시 파일만 지운다 (링크·다른 이름·받는 중인 것은 두기)', async () => {
    const old = new Date(Date.now() - 24 * 3600_000);
    const target = join(dir, 'target.txt');
    await writeFile(target, '지키기');
    await writeFile(join(dir, STALE), '덜 받음');
    await utimes(join(dir, STALE), old, old);
    const fresh = '.dotbugi-11111111-1111-1111-1111-111111111111.part';
    await writeFile(join(dir, fresh), '받는 중');
    const link = '.dotbugi-22222222-2222-2222-2222-222222222222.part';
    await symlink(target, join(dir, link));
    await lutimes(join(dir, link), old, old);
    await writeFile(join(dir, 'x.part'), '사용자 파일');
    await utimes(join(dir, 'x.part'), old, old);
    fetchMock.mockResolvedValue(new Response('ok'));
    await saveAttachment(URL_, dir, 'a.pdf', SESSION);
    expect((await readdir(dir)).sort()).toEqual([fresh, link, 'a.pdf', 'target.txt', 'x.part'].sort());
    expect(await readFile(target, 'utf8')).toBe('지키기');
  });
});
