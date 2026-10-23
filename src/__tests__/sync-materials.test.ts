import { mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InMemoryTransport, LATEST_PROTOCOL_VERSION, type JSONRPCMessage } from '@modelcontextprotocol/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { confirmRemovals } from '../commands/sync.js';
import { SessionExpiredError } from '../lms.js';
import { fileKey, weekName } from '../materials/course-page.js';
import { resolveRemoved, syncMaterials, type SyncResult } from '../materials/sync.js';
import { createServer } from '../server.js';

const SESSION = 'abcdefghij0123456789';
const L = 'https://learn.hansung.ac.kr';

const state = vi.hoisted(() => ({ home: '' }));
vi.mock('node:os', async (orig) => ({ ...(await orig<typeof import('node:os')>()), homedir: () => state.home }));
const getSession = vi.fn();
vi.mock('../session.js', () => ({ getSession: () => getSession() }));

// 익명화한 가짜 LMS. 리비전·내용을 바꿔 가며 증분 동작을 본다
let lms: {
  slidesRev: number;
  slides: string;
  folderRev: number;
  a: string;
  b: string;
  folder: boolean;
  folderStatus: number;
};
const SLIDES = (rev: number) => `${L}/pluginfile.php/50/mod_resource/content/${rev}/%EA%B0%95%EC%9D%98%201.pdf`;
const NOTES = `${L}/pluginfile.php/51/mod_resource/content/1/notes.txt`;
const FOLDER = (rev: number, path: string) => `${L}/pluginfile.php/52/mod_folder/content/${rev}/${path}`;
const EVIL_SLIDES = `${L}/pluginfile.php/60/mod_resource/content/1/x.txt`;

const courseItem = (id: string, title: string) =>
  `<li><a class="course_link" href="${L}/course/view.php?id=${id}"><div class="course-title"><h3>${title}</h3><p>교수</p></div></a></li>`;
const mod = (type: string, cmid: number, link = true) =>
  `<li id="module-${cmid}" class="activity ${type} modtype_${type}">${link ? `<a href="${L}/mod/${type}/view.php?id=${cmid}">자료</a>` : '자료'}</li>`;

function page(url: string): Response {
  const html = (body: string, status = 200) => new Response(body, { status });
  const redirect = (location: string) => new Response(null, { status: 303, headers: { location } });
  switch (url) {
    case `${L}/`:
      return html(
        `<ul class="my-course-lists">${courseItem('100', '[A반] 자료구조')}${courseItem('200', '../../evil')}</ul>`
      );
    case `${L}/course/view.php?id=100`:
      return html(`<ul class="topics">
        <li id="section-0" class="section main"><h3 class="sectionname">강의 개요</h3><ul>${mod('resource', 11)}</ul></li>
        <li id="section-3" class="section main"><h3 class="sectionname">3주차 [9월 15일 - 9월 21일]</h3>
          <ul>${lms.folder ? mod('folder', 13) : ''}${mod('resource', 14)}${mod('resource', 16, false)}</ul></li>
        <li id="section-4" class="section main"><h3 class="sectionname">../../탈출</h3><ul>${mod('resource', 12)}</ul></li>
      </ul>`);
    case `${L}/course/view.php?id=200`:
      return html(
        `<ul><li id="section-1"><span class="sectionname">Week 1</span><ul>${mod('resource', 21)}</ul></li></ul>`
      );
    case `${L}/mod/resource/view.php?id=11&redirect=1`:
      return redirect(`${SLIDES(lms.slidesRev)}?forcedownload=1`);
    // 삽입 표시 방식: 리다이렉트 대신 파일 링크가 든 화면
    case `${L}/mod/resource/view.php?id=12&redirect=1`:
      return html(
        `<div role="main"><object data="${NOTES}"><a href="${NOTES}?forcedownload=1">notes.txt</a></object></div>`
      );
    case `${L}/mod/resource/view.php?id=14&redirect=1`:
      return redirect('https://evil.example/pluginfile.php/1/mod_resource/content/1/x.pdf');
    case `${L}/mod/resource/view.php?id=21&redirect=1`:
      return redirect(EVIL_SLIDES);
    case `${L}/mod/folder/view.php?id=13`:
      if (lms.folderStatus !== 200) return html('error', lms.folderStatus);
      return html(`<div role="main"><ul>
        <li><a href="${FOLDER(lms.folderRev, 'a.txt')}?forcedownload=1">a.txt</a></li>
        <li><a href="${FOLDER(lms.folderRev, 'sub/b.txt')}?forcedownload=1">b.txt</a></li>
        <li><a href="https://evil.example/pluginfile.php/52/x.txt">x</a></li></ul></div>`);
    case SLIDES(lms.slidesRev):
      return html(lms.slides);
    case NOTES:
      return html('notes');
    case FOLDER(lms.folderRev, 'a.txt'):
      return html(lms.a);
    case FOLDER(lms.folderRev, 'sub/b.txt'):
      return html(lms.b);
    case EVIL_SLIDES:
      return html('x');
  }
  return html('not found', 404);
}
const fetchMock = vi.fn<typeof fetch>(async (input) => page(String(input)));
vi.stubGlobal('fetch', fetchMock);

const root = () => join(state.home, 'Downloads', 'dotbugi-mcp');
const course = (...p: string[]) => join(root(), '자료구조', ...p);
const manifestFile = () => course('.dotbugi-manifest.json');
const fileFetches = () => fetchMock.mock.calls.map(([u]) => String(u)).filter((u) => u.includes('/pluginfile.php/'));
const sync = () => syncMaterials(SESSION);
const statusOf = (r: SyncResult) => Object.fromEntries(r.files.map((f) => [f.path, f.status]));

beforeEach(async () => {
  state.home = await mkdtemp(join(tmpdir(), 'dotbugi-home-'));
  lms = { slidesRev: 1, slides: 'slides v1', folderRev: 1, a: 'A', b: 'B', folder: true, folderStatus: 200 };
});
afterEach(async () => {
  fetchMock.mockClear();
  await rm(state.home, { recursive: true, force: true });
});

describe('weekName / fileKey', () => {
  it.each([
    [3, '3주차 [9월 15일 - 9월 21일]', '3주차'],
    [1, 'Week 01', '1주차'],
    [0, '강의 개요', '강의 개요'],
    [5, '  ', 'section-5'],
  ])('%i %j → %j', (n, name, week) => expect(weekName(n, name)).toBe(week));

  it('리비전을 빼고 모듈 안 경로로 같은 파일을 알아본다', () => {
    expect(fileKey(13, new URL(FOLDER(1, 'sub/b.txt')))).toBe(fileKey(13, new URL(FOLDER(9, 'sub/b.txt'))));
    expect(fileKey(13, new URL(FOLDER(1, 'a.txt')))).toBe('13:a.txt');
  });
});

describe('syncMaterials', () => {
  it('과목·주차 폴더에 받고, 폴더 이름의 경로 문자를 지우며, LMS pluginfile 이 아닌 곳은 요청하지 않는다', async () => {
    const r = await sync();
    expect(statusOf(r)).toEqual({
      [course('강의 개요', '강의 1.pdf')]: 'added',
      [course('3주차', 'a.txt')]: 'added',
      [course('3주차', 'b.txt')]: 'added',
      [course('_.._탈출', 'notes.txt')]: 'added',
      [join(root(), '_.._evil', '1주차', 'x.txt')]: 'added',
    });
    expect(await readFile(course('강의 개요', '강의 1.pdf'), 'utf8')).toBe('slides v1');
    expect(r.warnings).toEqual([
      '[자료구조] 자료(id=14) 목록을 읽지 못했습니다: LMS 가 파일이 아닌 곳으로 이동시켰습니다.',
    ]);
    const urls = fetchMock.mock.calls.map(([u]) => String(u));
    expect(urls.every((u) => u.startsWith(`${L}/`))).toBe(true);
    // 제한된(링크 없는) 자료는 요청하지 않는다
    expect(urls.some((u) => u.includes('id=16'))).toBe(false);
    for (const [, init] of fetchMock.mock.calls) expect(init).toMatchObject({ redirect: 'manual' });
    // 홈 아래에는 저장 폴더 밖으로 아무것도 새지 않는다
    const all = await readdir(state.home, { recursive: true });
    expect(all.every((p) => p === 'Downloads' || p.startsWith(join('Downloads', 'dotbugi-mcp')))).toBe(true);
  });

  it('manifest 는 0600 이고 세션 없이 cmid·리비전 주소·해시·상대 경로를 담는다', async () => {
    await sync();
    const raw = await readFile(manifestFile(), 'utf8');
    expect(raw).not.toContain(SESSION);
    expect((await stat(manifestFile())).mode & 0o777).toBe(0o600);
    const m = JSON.parse(raw) as { courseId: string; files: Record<string, unknown>[] };
    expect(m.courseId).toBe('100');
    expect(m.files.find((f) => f.cmid === 11)).toMatchObject({
      key: '11:%EA%B0%95%EC%9D%98%201.pdf',
      url: SLIDES(1),
      path: join('강의 개요', '강의 1.pdf'),
      sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
  });

  it('리비전이 그대로면 파일을 다시 요청하지 않는다', async () => {
    await sync();
    fetchMock.mockClear();
    const r = await sync();
    expect(fileFetches()).toEqual([]);
    expect(new Set(r.files.map((f) => f.status))).toEqual(new Set(['unchanged']));
  });

  it('리비전이 바뀌고 내용도 바뀌면 받은 그대로인 파일을 새 버전으로 바꾼다', async () => {
    await sync();
    Object.assign(lms, { slidesRev: 2, slides: 'slides v2' });
    const r = await sync();
    expect(statusOf(r)[course('강의 개요', '강의 1.pdf')]).toBe('updated');
    expect(await readFile(course('강의 개요', '강의 1.pdf'), 'utf8')).toBe('slides v2');
    expect(await readdir(course('강의 개요'))).toEqual(['강의 1.pdf']);
  });

  it('리비전만 바뀌고 내용이 같으면 파일을 쓰지 않는다', async () => {
    await sync();
    const before = (await stat(course('3주차', 'a.txt'))).mtimeMs;
    lms.folderRev = 2;
    const r = await sync();
    expect(statusOf(r)[course('3주차', 'a.txt')]).toBe('unchanged');
    expect((await stat(course('3주차', 'a.txt'))).mtimeMs).toBe(before);
    expect((await readdir(course('3주차'))).sort()).toEqual(['a.txt', 'b.txt']);
    // 다음에는 새 리비전 주소를 기준으로 본다
    fetchMock.mockClear();
    await sync();
    expect(fileFetches()).toEqual([]);
  });

  it('받은 뒤 수정한 파일은 덮어쓰지 않고 "이름 (2)" 로 새 버전을 받고 경고한다', async () => {
    await sync();
    await writeFile(course('강의 개요', '강의 1.pdf'), '내 필기');
    Object.assign(lms, { slidesRev: 2, slides: 'slides v2' });
    const r = await sync();
    expect(await readFile(course('강의 개요', '강의 1.pdf'), 'utf8')).toBe('내 필기');
    expect(await readFile(course('강의 개요', '강의 1 (2).pdf'), 'utf8')).toBe('slides v2');
    expect(r.warnings).toContainEqual(expect.stringContaining('받은 뒤 수정된 파일이라 덮어쓰지 않고'));
  });

  it('LMS 에 처음 받는 파일과 같은 이름의 내 파일이 있으면 번호를 붙여 받는다', async () => {
    await sync();
    await rm(manifestFile());
    await writeFile(course('3주차', 'a.txt'), '내 파일');
    const r = await sync();
    expect(await readFile(course('3주차', 'a.txt'), 'utf8')).toBe('내 파일');
    expect(await readFile(course('3주차', 'a (2).txt'), 'utf8')).toBe('A');
    expect(r.warnings).toContainEqual(expect.stringContaining('같은 이름의 파일이 이미 있어'));
  });

  it('로컬에서 지운 파일은 다시 받는다', async () => {
    await sync();
    await rm(course('3주차', 'a.txt'));
    const r = await sync();
    expect(statusOf(r)[course('3주차', 'a.txt')]).toBe('added');
  });

  it('LMS 에서 사라진 파일은 지우지 않고 보고만 하며, 목록을 못 읽은 모듈은 삭제로 보지 않는다', async () => {
    await sync();
    await writeFile(course('3주차', 'b.txt'), '수정함');
    lms.folderStatus = 500;
    const failed = await sync();
    expect(failed.removed).toEqual([]);
    lms.folder = false;
    const r = await sync();
    expect(r.removed.map(({ path, locallyModified }) => ({ path, locallyModified }))).toEqual([
      { path: course('3주차', 'a.txt'), locallyModified: false },
      { path: course('3주차', 'b.txt'), locallyModified: true },
    ]);
    expect((await readdir(course('3주차'))).sort()).toEqual(['a.txt', 'b.txt']);
  });

  it('형식이 틀린 manifest 는 손대지 않고 그 과목을 건너뛴다', async () => {
    await sync();
    await writeFile(manifestFile(), '{"version":1,"courseId":"100","files":[{"key":"__proto__"}]}');
    fetchMock.mockClear();
    const r = await sync();
    expect(r.warnings).toContainEqual(expect.stringContaining('형식이 올바르지 않아 이 과목을 건너뜁니다'));
    expect(r.files.some((f) => f.course === '자료구조')).toBe(false);
    expect(await readFile(manifestFile(), 'utf8')).toContain('__proto__');
  });

  it('manifest 경로를 믿지 않는다 — 폴더 밖을 가리키면 덮어쓰지도, 지우지도, 보고하지도 않는다', async () => {
    await sync();
    const outside = join(state.home, 'outside.txt');
    await writeFile(outside, '중요');
    const m = JSON.parse(await readFile(manifestFile(), 'utf8')) as { files: { cmid: number; path: string }[] };
    for (const f of m.files) if (f.cmid === 13) f.path = join('..', '..', '..', 'outside.txt');
    await writeFile(manifestFile(), JSON.stringify(m));
    lms.folder = false;
    const r = await sync();
    expect(r.removed).toEqual([]);
    expect(await readFile(outside, 'utf8')).toBe('중요');
  });

  it('세션이 만료되면 멈추고, 그때까지 받은 기록은 남긴다', async () => {
    fetchMock.mockImplementation(async (input) =>
      String(input) === NOTES
        ? new Response(null, { status: 303, headers: { location: `${L}/login/index.php` } })
        : page(String(input))
    );
    await expect(sync()).rejects.toBeInstanceOf(SessionExpiredError);
    fetchMock.mockImplementation(async (input) => page(String(input)));
    const m = JSON.parse(await readFile(manifestFile(), 'utf8')) as { files: unknown[] };
    expect(m.files).toHaveLength(3);
  });
});

describe('sync_materials 도구', () => {
  it('로컬 파일을 만드는 비파괴 도구로 등록되고, 결과에 세션·내부 키를 내보내지 않는다', async () => {
    getSession.mockResolvedValue({ session: SESSION, savedAt: '', method: 'extension' });
    const [client, server] = InMemoryTransport.createLinkedPair();
    const replies = new Map<number, (r: Record<string, unknown>) => void>();
    client.onmessage = (msg: JSONRPCMessage) => {
      if ('id' in msg) replies.get(msg.id as number)?.(('result' in msg ? msg.result : msg) as Record<string, unknown>);
    };
    await createServer().connect(server);
    let id = 0;
    const send = (method: string, params?: Record<string, unknown>) =>
      new Promise<Record<string, unknown>>((resolve) => {
        replies.set(++id, resolve);
        void client.send({ jsonrpc: '2.0', id, method, params });
      });
    await send('initialize', {
      protocolVersion: LATEST_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 't', version: '0' },
    });
    const { tools } = (await send('tools/list')) as { tools: { name: string; annotations: unknown }[] };
    expect(tools.find((t) => t.name === 'sync_materials')?.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: false,
    });
    await sync();
    lms.folder = false;
    const result = await send('tools/call', { name: 'sync_materials', arguments: { course: '자료구조' } });
    const out = result.structuredContent as { files: unknown[]; removed: Record<string, unknown>[] };
    expect(out.files).toHaveLength(2);
    expect(out.removed[0]).toEqual({ course: '자료구조', path: course('3주차', 'a.txt'), locallyModified: false });
    expect(JSON.stringify(result)).not.toContain(SESSION);
    expect((result.content as { text: string }[])[0].text).toContain('dotbugi-mcp sync 로 하나씩 확인');
  });
});

describe('삭제 확인 (CLI)', () => {
  const removedAfterSync = async () => {
    await sync();
    lms.folder = false;
    return (await sync()).removed;
  };
  const stderr = () => vi.spyOn(process.stderr, 'write').mockReturnValue(true);

  it('기본(엔터)은 유지하고, 남긴 파일은 다시 묻지 않는다', async () => {
    stderr();
    const removed = await removedAfterSync();
    const ask = vi.fn(async () => '');
    await confirmRemovals(removed, ask);
    expect(ask).toHaveBeenCalledTimes(2);
    expect((await readdir(course('3주차'))).sort()).toEqual(['a.txt', 'b.txt']);
    expect((await sync()).removed).toEqual([]);
    vi.restoreAllMocks();
  });

  it('y 면 지우고 기록에서 뺀다. 수정한 파일은 추가로 경고한다', async () => {
    const err = stderr();
    const removed = await removedAfterSync();
    await writeFile(course('3주차', 'b.txt'), '수정함');
    const r = (await sync()).removed;
    expect(r.map((f) => f.locallyModified)).toEqual([false, true]);
    await confirmRemovals(r, async () => 'y');
    expect(await readdir(course('3주차'))).toEqual([]);
    expect(err.mock.calls.join('')).toContain('받은 뒤 수정된 파일입니다');
    expect(removed).toHaveLength(2);
    expect(JSON.parse(await readFile(manifestFile(), 'utf8')).files).toHaveLength(2);
    vi.restoreAllMocks();
  });

  it('TTY 가 아니면 묻지 않고 그대로 두며, 다음 실행에서 다시 보고한다', async () => {
    stderr();
    const removed = await removedAfterSync();
    await confirmRemovals(removed);
    expect((await readdir(course('3주차'))).sort()).toEqual(['a.txt', 'b.txt']);
    expect((await sync()).removed).toHaveLength(2);
    vi.restoreAllMocks();
  });

  it('지우기 전에 manifest 를 다시 검증한다 — 그사이 폴더 밖을 가리키게 바뀌면 지우지 않는다', async () => {
    const [item] = await removedAfterSync();
    const outside = join(state.home, 'outside.txt');
    await writeFile(outside, '중요');
    const m = JSON.parse(await readFile(manifestFile(), 'utf8')) as { files: { key: string; path: string }[] };
    for (const f of m.files) if (f.key === item.key) f.path = join('..', '..', '..', 'outside.txt');
    await writeFile(manifestFile(), JSON.stringify(m));
    await resolveRemoved(item, true);
    expect(await readFile(outside, 'utf8')).toBe('중요');
  });
});
