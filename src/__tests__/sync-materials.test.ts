import { mkdir, mkdtemp, readdir, readFile, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InMemoryTransport, LATEST_PROTOCOL_VERSION, type JSONRPCMessage } from '@modelcontextprotocol/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { confirmRemovals } from '../commands/sync.js';
import { SessionExpiredError } from '../lms.js';
import { fileKey, weekName } from '../materials/course-page.js';
import { resolveRemoved, syncMaterials, withSyncLock, type SyncResult } from '../materials/sync.js';
import { createServer } from '../server.js';
import { previousSemester, semesterOf } from '../storage.js';

const SESSION = 'abcdefghij0123456789';
const L = 'https://learn.hansung.ac.kr';

const state = vi.hoisted(() => ({ home: '' }));
vi.mock('node:os', async (orig) => ({ ...(await orig<typeof import('node:os')>()), homedir: () => state.home }));
const getSession = vi.fn();
vi.mock('../session.js', () => ({ getSession: () => getSession() }));
// 한 번 실행 상한은 테스트에서만 줄인다
const caps = vi.hoisted(() => ({ files: 300, mcpFiles: 60 }));
vi.mock('../constants.js', async (orig) => ({
  ...(await orig<typeof import('../constants.js')>()),
  get MATERIAL_MAX_FILES_PER_RUN() {
    return caps.files;
  },
  get MATERIAL_MCP_MAX_FILES() {
    return caps.mcpFiles;
  },
}));

// 익명화한 가짜 LMS. 리비전·내용을 바꿔 가며 증분 동작을 본다
let lms: {
  slidesRev: number;
  slides: string;
  folderRev: number;
  a: string;
  b: string;
  folder: boolean;
  folderStatus: number;
  twin: boolean;
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
        `<ul class="my-course-lists">${courseItem('100', '[A반] 자료구조')}${courseItem('200', '../../evil')}${
          lms.twin ? courseItem('300', '[B반] 자료구조') : ''
        }</ul>`
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
    // 이름이 같은 다른 과목 (분반)
    case `${L}/course/view.php?id=300`:
      return html(
        `<ul><li id="section-1"><span class="sectionname">1주차</span><ul>${mod('resource', 21)}</ul></li></ul>`
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
        <li><a href="https://evil.example/pluginfile.php/52/x.txt">x</a></li>
        <li><a href="${L}/pluginfile.php/52/mod_folder/intro/0/desc.pdf">설명란 첨부</a></li></ul></div>`);
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
const sem = () => join(root(), semesterOf(new Date()));
const course = (...p: string[]) => join(sem(), '자료구조', ...p);
const manifestFile = () => course('.dotbugi-manifest.json');
const fileFetches = () => fetchMock.mock.calls.map(([u]) => String(u)).filter((u) => u.includes('/pluginfile.php/'));
const sync = () => syncMaterials(SESSION);
const statusOf = (r: SyncResult) => Object.fromEntries(r.files.map((f) => [f.path, f.status]));

beforeEach(async () => {
  state.home = await mkdtemp(join(tmpdir(), 'dotbugi-home-'));
  lms = {
    slidesRev: 1,
    slides: 'slides v1',
    folderRev: 1,
    a: 'A',
    b: 'B',
    folder: true,
    folderStatus: 200,
    twin: false,
  };
});
afterEach(async () => {
  caps.files = 300;
  caps.mcpFiles = 60;
  fetchMock.mockClear();
  fetchMock.mockImplementation(async (input) => page(String(input)));
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
      [join(sem(), '_.._evil', '1주차', 'x.txt')]: 'added',
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
    expect((result.content as { text: string }[])[0].text).toContain('delete_materials');
  });

  it('한 번 호출은 MCP 상한까지만 받고 more 로 알리며, 다시 호출하면 중복 없이 이어 받는다. 진행 알림은 토큰이 있을 때만', async () => {
    getSession.mockResolvedValue({ session: SESSION, savedAt: '', method: 'extension' });
    caps.mcpFiles = 2;
    const [client, server] = InMemoryTransport.createLinkedPair();
    const replies = new Map<number, (r: Record<string, unknown>) => void>();
    const progress: Record<string, unknown>[] = [];
    client.onmessage = (msg: JSONRPCMessage) => {
      if ('method' in msg && msg.method === 'notifications/progress')
        progress.push(msg.params as Record<string, unknown>);
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
    type Out = { files: { status: string }[]; removed: unknown[]; more: boolean };
    const first = await send('tools/call', { name: 'sync_materials', arguments: { course: '자료구조' } });
    const a = first.structuredContent as Out;
    expect(a.files.filter((f) => f.status === 'added')).toHaveLength(2);
    expect(a).toMatchObject({ more: true, removed: [] });
    expect((first.content as { text: string }[])[0].text).toContain('다시 호출하면 이어서 받습니다');
    expect(progress).toEqual([]);

    const second = await send('tools/call', {
      name: 'sync_materials',
      arguments: { course: '자료구조' },
      _meta: { progressToken: 7 },
    });
    const b = second.structuredContent as Out;
    expect(b.more).toBe(false);
    expect(b.files.map((f) => f.status).sort()).toEqual(['added', 'added', 'unchanged', 'unchanged']);
    expect((await readdir(course('3주차'))).sort()).toEqual(['a.txt', 'b.txt']);
    expect(progress.length).toBeGreaterThan(0);
    expect(progress.every((p) => p.progressToken === 7 && typeof p.message === 'string')).toBe(true);
    // 진행 메시지에 과목명(LMS 데이터)을 넣지 않는다
    expect(JSON.stringify(progress)).not.toContain('자료구조');
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

describe('리뷰 반영: 링크 폴더·경합·중단·상한', () => {
  const outside = () => join(state.home, 'outside');

  it('주차 폴더가 밖을 가리키는 링크면 그 안에 쓰지도, 바꾸지도 않는다', async () => {
    await sync();
    await mkdir(outside());
    await rename(course('3주차'), join(outside(), '3주차'));
    await symlink(join(outside(), '3주차'), course('3주차'));
    lms.folderRev = 2;
    Object.assign(lms, { a: 'A2', b: 'B2' });
    const r = await sync();
    expect(await readFile(join(outside(), '3주차', 'a.txt'), 'utf8')).toBe('A');
    expect((await readdir(join(outside(), '3주차'))).sort()).toEqual(['a.txt', 'b.txt']);
    expect(r.warnings).toContainEqual(expect.stringContaining('폴더가 아니라(링크 등) 건너뜁니다'));
  });

  it('과목 폴더가 링크면 manifest 를 읽지도 쓰지도 않고 건너뛴다', async () => {
    await mkdir(outside());
    await mkdir(sem(), { recursive: true });
    await symlink(outside(), course());
    const r = await sync();
    expect(await readdir(outside())).toEqual([]);
    expect(r.warnings).toContainEqual(expect.stringContaining('폴더가 아니라(링크 등) 건너뜁니다'));
  });

  it('링크된 주차 폴더 속 파일은 삭제 확인에서 y 여도 지우지 않는다', async () => {
    const [item] = await (async () => {
      await sync();
      lms.folder = false;
      return (await sync()).removed;
    })();
    await mkdir(outside());
    await rename(course('3주차'), join(outside(), '3주차'));
    await symlink(join(outside(), '3주차'), course('3주차'));
    await expect(resolveRemoved(item, true)).rejects.toThrow('링크 등');
    expect((await readdir(join(outside(), '3주차'))).sort()).toEqual(['a.txt', 'b.txt']);
  });

  it('받는 동안 사용자가 파일을 고치면 덮어쓰지 않고 "(2)" 로 저장한다', async () => {
    await sync();
    Object.assign(lms, { slidesRev: 2, slides: 'slides v2' });
    fetchMock.mockImplementation(async (input) => {
      if (String(input) === SLIDES(2)) await writeFile(course('강의 개요', '강의 1.pdf'), '받는 중 필기');
      return page(String(input));
    });
    await sync();
    expect(await readFile(course('강의 개요', '강의 1.pdf'), 'utf8')).toBe('받는 중 필기');
    expect(await readFile(course('강의 개요', '강의 1 (2).pdf'), 'utf8')).toBe('slides v2');
  });

  it('받다가 실패하면 자료 이름의 파일도 .part 도 남기지 않는다', async () => {
    fetchMock.mockImplementation(async (input) => {
      if (String(input) !== FOLDER(1, 'a.txt')) return page(String(input));
      const body = new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(new TextEncoder().encode('par'));
          c.error(new Error('끊김'));
        },
      });
      return new Response(body);
    });
    const r = await sync();
    expect((await readdir(course('3주차'))).sort()).toEqual(['b.txt']);
    expect(r.warnings).toContainEqual(expect.stringContaining('a.txt 을(를) 받지 못했습니다'));
  });

  it('동기화는 한 번에 하나만 돈다', async () => {
    let release!: () => void;
    const first = withSyncLock(() => new Promise<void>((r) => (release = r)));
    await vi.waitFor(() => expect(release).toBeDefined());
    await expect(withSyncLock(async () => {})).rejects.toThrow('다른 강의자료 동기화');
    release();
    await first;
    await expect(withSyncLock(async () => 1)).resolves.toBe(1);
  });

  it('설명란 첨부 등 자료 본문이 아닌 pluginfile 은 받지 않는다', async () => {
    await sync();
    expect(fileFetches().some((u) => u.includes('/intro/'))).toBe(false);
  });

  it('이번 학기 폴더에 기록이 없고 직전 학기 폴더에 같은 과목이 있으면 그 폴더를 이어 쓴다 (다시 받지 않음)', async () => {
    await sync();
    const prev = join(root(), previousSemester(semesterOf(new Date())));
    await mkdir(prev);
    await rename(course(), join(prev, '자료구조'));
    fetchMock.mockClear();
    const r = await sync();
    expect(fileFetches().filter((u) => !u.includes('/60/'))).toEqual([]);
    expect(r.files.filter((f) => f.course === '자료구조').every((f) => f.path.startsWith(join(prev, '자료구조')))).toBe(
      true
    );
    await expect(readdir(course())).rejects.toThrow();
  });

  it('학기 폴더 전 구조의 과목 폴더(manifest 있음)는 이번 학기 폴더로 옮기고, 다시 받지 않는다', async () => {
    await sync();
    await rename(course(), join(root(), '자료구조'));
    // 다른 과목의 manifest 가 있는 같은 이름 폴더·manifest 없는 폴더는 건드리지 않는다
    await mkdir(join(root(), '_.._evil'), { recursive: true });
    await rm(join(sem(), '_.._evil'), { recursive: true });
    fetchMock.mockClear();
    const r = await sync();
    expect(fileFetches().filter((u) => !u.includes('/60/'))).toEqual([]);
    expect(Object.values(statusOf(r)).filter((s) => s !== 'unchanged')).toEqual(['added']);
    expect(await readdir(course('3주차'))).toEqual(['a.txt', 'b.txt']);
    expect((await readdir(root())).sort()).toEqual([semesterOf(new Date()), '_.._evil'].sort());
    expect(r.warnings.filter((w) => w.includes('예전 폴더'))).toEqual([]);
  });

  it('새 학기 폴더에 같은 과목 폴더가 이미 있으면 옮기지도 합치지도 않고 경고한다', async () => {
    await sync();
    await rename(course(), join(root(), '자료구조'));
    await mkdir(course());
    const r = await sync();
    expect(r.warnings).toContainEqual(expect.stringContaining('이미 있습니다'));
    expect(await readdir(join(root(), '자료구조', '3주차'))).toEqual(['a.txt', 'b.txt']);
  });

  it('같은 이름의 다른 과목은 "<과목> (<번호>)" 폴더에 받는다 (순서가 바뀌어도 같은 폴더)', async () => {
    await sync();
    lms.twin = true;
    await sync();
    expect(await readdir(join(sem(), '자료구조 (300)', '1주차'))).toEqual(['x.txt']);
    fetchMock.mockClear();
    const r = await sync();
    expect(fileFetches()).toEqual([]);
    expect(r.warnings.filter((w) => w.includes('다른 과목'))).toEqual([]);
  });

  it('보고한 뒤 파일이 바뀌면 y 여도 지우지 않는다', async () => {
    await sync();
    lms.folder = false;
    const [item] = (await sync()).removed;
    await writeFile(item.path, '그사이 필기');
    expect(await resolveRemoved(item, true)).toBe('modified');
    expect(await readFile(item.path, 'utf8')).toBe('그사이 필기');
  });

  it('한 번 실행의 상한을 넘으면 나머지는 받지 않고 경고하며, 다음 실행에서 이어 받는다', async () => {
    caps.files = 2;
    const r = await sync();
    expect(r.files).toHaveLength(2);
    expect(r.warnings).toContainEqual(expect.stringContaining('한 번에 받는 상한'));
    expect(r.removed).toEqual([]);
    caps.files = 300;
    expect((await sync()).files.filter((f) => f.status === 'added')).toHaveLength(3);
  });

  it('시간 상한이 지나면 파일 사이에서 멈추고, 못 받은 파일을 사라진 것으로 보지 않는다', async () => {
    const r = await syncMaterials(SESSION, undefined, { maxFiles: 300, maxBytes: 2 ** 40, maxMs: 0 });
    expect(r.files).toEqual([]);
    expect(r).toMatchObject({ more: true, removed: [] });
    expect(r.warnings).toContainEqual(expect.stringContaining('0분)에 걸려'));
    expect((await sync()).more).toBe(false);
  });
});

describe('delete_materials 도구', () => {
  // 확인 창 지원 여부·사용자 응답을 흉내 내는 클라이언트
  // hold 면 확인 창에 답하지 않고 기다린다 (호출 취소 확인용)
  const connect = async (elicit?: Record<string, unknown>, hold = false) => {
    getSession.mockResolvedValue({ session: SESSION, savedAt: '', method: 'extension' });
    const [client, server] = InMemoryTransport.createLinkedPair();
    const replies = new Map<number, (r: Record<string, unknown>) => void>();
    const asked: string[] = [];
    const ctl: { pendingElicit?: unknown; cancel: () => Promise<void> } = {
      cancel: () =>
        client.send({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: id, reason: 't' } }),
    };
    client.onmessage = (msg: JSONRPCMessage) => {
      if ('method' in msg && msg.method === 'elicitation/create' && 'id' in msg) {
        asked.push((msg.params as { message: string }).message);
        if (hold) ctl.pendingElicit = msg.id;
        else void client.send({ jsonrpc: '2.0', id: msg.id, result: elicit! });
      } else if ('id' in msg)
        replies.get(msg.id as number)?.(('result' in msg ? msg.result : msg) as Record<string, unknown>);
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
      capabilities: elicit ? { elicitation: { form: {} } } : {},
      clientInfo: { name: 't', version: '0' },
    });
    const call = async (args: Record<string, unknown> = {}) => {
      const r = await send('tools/call', { name: 'delete_materials', arguments: args });
      return (r.content as { text: string }[])[0].text;
    };
    return { send, call, asked, client: ctl };
  };
  const setup = async () => {
    await sync();
    lms.folder = false;
  };
  const left = async () => (await readdir(course('3주차'))).sort();

  it('삭제 도구들은 destructiveHint 로 등록된다', async () => {
    const { send } = await connect();
    const { tools } = (await send('tools/list')) as { tools: { name: string; annotations: unknown }[] };
    for (const name of ['delete_materials', 'asr_remove'])
      expect(tools.find((t) => t.name === name)?.annotations).toMatchObject({ destructiveHint: true });
  });

  it('사용자가 승인하면 보고된 파일만 지우고, 받은 뒤 수정한 파일은 묻지도 지우지도 않는다', async () => {
    await setup();
    await writeFile(course('3주차', 'b.txt'), '필기');
    const { call, asked } = await connect({ action: 'accept', content: { confirm: true } });
    const text = await call();
    expect(asked).toHaveLength(1);
    expect(asked[0]).toContain(course('3주차', 'a.txt'));
    expect(asked[0]).not.toContain('b.txt');
    expect(await left()).toEqual(['b.txt']);
    expect(text).toContain('삭제 1개');
    expect(text).toContain(`${course('3주차', 'b.txt')} — 받은 뒤 수정됐거나`);
    const m = JSON.parse(await readFile(manifestFile(), 'utf8')) as { files: { path: string }[] };
    expect(m.files.map((f) => f.path)).not.toContain(join('3주차', 'a.txt'));
    expect(text).not.toContain(SESSION);
  });

  it('대상을 정하려고 돌린 동기화가 새로 받은 파일도 알린다', async () => {
    await setup();
    Object.assign(lms, { slidesRev: 2, slides: 'slides v2' });
    const { call } = await connect({ action: 'decline' });
    const text = await call();
    expect(text).toContain(`이번 동기화로 받은 파일 1개:\n- ${course('강의 개요', '강의 1.pdf')}`);
  });

  it('클라이언트가 호출을 취소하면 확인 대기를 끝내고 sync 잠금을 푼다', async () => {
    await setup();
    const { send, client } = await connect({ action: 'accept', content: { confirm: true } }, true);
    void send('tools/call', { name: 'delete_materials', arguments: {} });
    await vi.waitFor(() => expect(client.pendingElicit).toBeDefined());
    await client.cancel();
    await vi.waitFor(() => expect(withSyncLock(async () => 1)).resolves.toBe(1));
    expect(await left()).toEqual(['a.txt', 'b.txt']);
  });

  it.each([{ action: 'decline' }, { action: 'cancel' }, { action: 'accept', content: { confirm: false } }])(
    '%o 면 아무것도 지우지 않는다',
    async (reply) => {
      await setup();
      const { call } = await connect(reply);
      expect(await call()).toContain('승인하지 않아');
      expect(await left()).toEqual(['a.txt', 'b.txt']);
    }
  );

  it('확인 창이 없으면 토큰을 주고, 같은 목록에 그 토큰으로 다시 불러야만 지운다', async () => {
    await setup();
    const { call } = await connect();
    const first = await call({ paths: [join(semesterOf(new Date()), '자료구조/3주차/a.txt')] });
    expect(await left()).toEqual(['a.txt', 'b.txt']);
    const token = /confirmToken: "([0-9a-f]+)"/.exec(first)![1];
    // 다른 목록(전체)에는 쓸 수 없고, 거절된 토큰은 버려진다
    expect(await call({ confirmToken: token })).toContain('아무것도 지우지 않았습니다');
    expect(
      await call({ paths: [join(semesterOf(new Date()), '자료구조/3주차/a.txt')], confirmToken: token })
    ).toContain('아무것도');
    expect(await left()).toEqual(['a.txt', 'b.txt']);
    const again = /confirmToken: "([0-9a-f]+)"/.exec(
      await call({ paths: [join(semesterOf(new Date()), '자료구조/3주차/a.txt')] })
    )![1];
    expect(
      await call({ paths: [join(semesterOf(new Date()), '자료구조/3주차/a.txt')], confirmToken: again })
    ).toContain('삭제 1개');
    expect(await left()).toEqual(['b.txt']);
  });

  it('보고되지 않은 경로(폴더 밖 포함)는 지우지 않고, 링크는 따라가지 않는다', async () => {
    await setup();
    const outside = join(state.home, 'outside.txt');
    await writeFile(outside, '중요');
    await rm(course('3주차', 'a.txt'));
    await symlink(outside, course('3주차', 'a.txt'));
    const { call, asked } = await connect({ action: 'accept', content: { confirm: true } });
    const text = await call({ paths: ['../../outside.txt', course('3주차', 'a.txt')] });
    expect(asked).toEqual([]);
    expect(text).toContain(`${outside} — LMS 에서 사라진 파일로 보고되지 않음`);
    expect(await readFile(outside, 'utf8')).toBe('중요');
    expect(await left()).toEqual(['a.txt', 'b.txt']);
  });
});
