import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InMemoryTransport, LATEST_PROTOCOL_VERSION, type JSONRPCMessage } from '@modelcontextprotocol/server';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer } from '../server.js';
import { semesterOf, storageRoot } from '../storage.js';
import { fakeLmsFetch, NOW } from './fixtures/lms-pages.js';

// 노트·요약은 저장 위치(~/Downloads)에 쓴다 — 실제 홈 대신 테스트 홈
const state = vi.hoisted(() => ({ home: '' }));
vi.mock('node:os', async (orig) => ({ ...(await orig<typeof import('node:os')>()), homedir: () => state.home }));

const getSession = vi.fn();
vi.mock('../session.js', () => ({ getSession: () => getSession() }));
const fetchMock = vi.fn<typeof fetch>(fakeLmsFetch);
vi.stubGlobal('fetch', fetchMock);

let send: (method: string, params?: Record<string, unknown>) => Promise<Record<string, unknown>>;
beforeAll(async () => {
  const [client, server] = InMemoryTransport.createLinkedPair();
  const pending = new Map<number, (result: Record<string, unknown>) => void>();
  client.onmessage = (msg: JSONRPCMessage) => {
    if ('id' in msg && 'result' in msg) pending.get(msg.id as number)?.(msg.result as Record<string, unknown>);
    else if ('id' in msg && 'error' in msg) pending.get(msg.id as number)?.({ rpcError: msg.error });
  };
  await createServer().connect(server);
  let id = 0;
  send = (method, params) =>
    new Promise((resolve) => {
      pending.set(++id, resolve);
      void client.send({ jsonrpc: '2.0', id, method, params });
    });
  // 확인 창(elicitation)이 없는 클라이언트 — 첫 호출은 토큰, 두 번째 호출에서 승인
  await send('initialize', {
    protocolVersion: LATEST_PROTOCOL_VERSION,
    capabilities: {},
    clientInfo: { name: 'test', version: '0' },
  });
  await client.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
});

const call = (name: string, args: Record<string, unknown> = {}) => send('tools/call', { name, arguments: args });
const text = (result: Record<string, unknown>) => (result.content as { text: string }[])[0].text;
const tokenOf = (t: string) => /confirmToken: "([0-9a-f]+)"/.exec(t)?.[1];
// 토큰을 받아 같은 인자로 다시 불러 승인된 결과를 받는다
async function approve(name: string, args: Record<string, unknown>) {
  const first = text(await call(name, args));
  const token = tokenOf(first);
  expect(token, first).toBeDefined();
  return text(await call(name, { ...args, confirmToken: token }));
}
const jsonOf = (t: string) => JSON.parse(t.slice(t.indexOf('\n['))) as Record<string, unknown>[];

const courseDir = () => join(storageRoot(), semesterOf(NOW), '자료구조');
const weekDir = (week: string) => join(courseDir(), week);

beforeEach(async () => {
  vi.useFakeTimers({ now: NOW, toFake: ['Date'] });
  state.home = await mkdtemp(join(tmpdir(), 'dotbugi-notes-tools-'));
  await mkdir(weekDir('3주차'), { recursive: true });
  await writeFile(join(weekDir('3주차'), 'a.pdf'), 'v1');
  getSession.mockResolvedValue({ session: 'abcdefghij0123456789', savedAt: '', method: 'extension' });
  fetchMock.mockImplementation(fakeLmsFetch);
});
afterEach(async () => {
  vi.useRealTimers();
  fetchMock.mockClear();
  await rm(state.home, { recursive: true, force: true });
});

describe('list_notes', () => {
  it('승인되면 주차마다 읽을 파일·저장 폴더와 STT 없는 동영상 강의를 돌려준다', async () => {
    const t = await approve('list_notes', { course: '자료구조', instructions: '예제  위주' });
    expect(t).toContain('사용자가 승인했습니다');
    const result = jsonOf(t);
    expect(result.find((r) => r.week === '3주차')).toMatchObject({
      course: '자료구조',
      status: 'new',
      dir: weekDir('3주차'),
      files: ['a.pdf'],
      instructions: '예제 위주',
    });
    // LMS 의 8주차 동영상 강의는 STT 결과가 없어 stt-only 로 알린다
    expect(result.find((r) => r.week === '8주차')).toMatchObject({ status: 'stt-only' });
    expect((result.find((r) => r.week === '8주차')?.missingStt as unknown[]).length).toBeGreaterThan(0);
  });

  it('토큰 없는 첫 호출은 대상 목록만 보여 주고 아무것도 만들지 않는다', async () => {
    const t = text(await call('list_notes', { course: '자료구조', week: 3 }));
    expect(t).toContain('1개 주차의 강의 노트를 만듭니다');
    expect(t).toContain('자료구조 · 3주차 · 새로');
    expect(t).not.toContain('사용자가 승인했습니다');
  });

  it('최신 노트만 있으면 새로 만들 노트가 없다고 알린다', async () => {
    await call('save_notes', { dir: weekDir('3주차'), content: '# 노트' });
    const t = text(await call('list_notes', { course: '자료구조', week: 3 }));
    expect(t).toContain('새로 만들 노트가 없습니다.');
    expect(t).toContain('최신 노트라 건너뛴 주차: 1개');
  });

  it('동영상 강의 목록을 못 받아도 노트 대상은 고르고 경고를 붙인다', async () => {
    await call('save_notes', { dir: weekDir('3주차'), content: '# 노트' });
    // 강좌 목록은 받고 강좌 페이지는 실패 — 과목별 실패 수를 알린다
    fetchMock.mockImplementation((url) =>
      String(url).includes('/course/view.php') ? Promise.reject(new Error('network down')) : fakeLmsFetch(url)
    );
    const t = text(await call('list_notes', { course: '자료구조' }));
    expect(t).toContain('새로 만들 노트가 없습니다.');
    expect(t).toContain('※ 과목 2개의 동영상 강의 목록을 받지 못했습니다.');
  });

  it('동영상 강의 목록 조회가 통째로 실패해도 노트 대상은 고르고 STT 여부를 확인하지 않았다고 알린다', async () => {
    // 강좌 목록은 노트 대상 고를 때 한 번만 받고, 동영상 강의 목록을 위한 두 번째 조회는 실패
    let home = 0;
    fetchMock.mockImplementation((url) =>
      String(url) === 'https://learn.hansung.ac.kr/' && ++home % 2 === 0
        ? Promise.reject(new Error('network down MoodleSession=abcdefghij0123456789'))
        : fakeLmsFetch(url)
    );
    const t = await approve('list_notes', { course: '자료구조', week: 3 });
    expect(jsonOf(t)).toMatchObject([{ week: '3주차', status: 'new', missingStt: [] }]);
    expect(t).toContain('동영상 강의 목록을 받지 못해 STT 여부는 확인하지 않았습니다');
    // 오류 메시지에 섞인 세션 쿠키는 가린다
    expect(t).toContain('MoodleSession=[REDACTED]');
    expect(t).not.toContain('abcdefghij0123456789');
  });

  it('없는 과목이면 오류, 세션 오류도 도구 오류로 돌려준다', async () => {
    const r = await call('list_notes', { course: '없는과목' });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain('"없는과목" 과목을 찾지 못했습니다');
    getSession.mockRejectedValueOnce(new Error('세션이 없습니다'));
    const s = await call('list_notes', {});
    expect(s).toMatchObject({ isError: true });
    expect(text(s)).toContain('세션이 없습니다');
  });

  it('토큰이 틀리면 노트 목록을 돌려주지 않는다', async () => {
    const t = text(await call('list_notes', { course: '자료구조', week: 3, confirmToken: 'deadbeef' }));
    expect(t).toContain('노트를 만들지 않았습니다');
    expect(t).not.toContain('사용자가 승인했습니다');
  });
});

describe('save_notes', () => {
  it('주차 폴더에 노트를 쓰고, 이미 있으면 replace 없이는 오류', async () => {
    const r = await call('save_notes', { dir: weekDir('3주차'), content: '# 노트' });
    expect(text(r)).toContain('노트를 저장했습니다');
    expect(await readFile(join(weekDir('3주차'), '노트-3주차.md'), 'utf8')).toContain('# 노트');
    const again = await call('save_notes', { dir: weekDir('3주차'), content: '# 새 노트' });
    expect(again).toMatchObject({ isError: true });
    expect(text(again)).toContain('replace: true');
  });

  it('주차 폴더가 아니면 쓰지 않는다', async () => {
    const r = await call('save_notes', { dir: courseDir(), content: 'x' });
    expect(r).toMatchObject({ isError: true });
    expect(text(r)).toContain('주차 폴더');
  });
});

describe('list_summary + save_summary', () => {
  it('노트가 있으면 승인 뒤 과목 폴더·노트 목록을 돌려주고, 저장한 요약은 다음에 건너뛴다', async () => {
    await call('save_notes', { dir: weekDir('3주차'), content: '# 노트' });
    const t = await approve('list_summary', { course: '자료구조', fromWeek: 3, toWeek: 3, instructions: '개념' });
    const [target] = jsonOf(t);
    expect(target).toMatchObject({
      course: '자료구조',
      range: '3주차',
      status: 'new',
      dir: courseDir(),
      fromWeek: 3,
      toWeek: 3,
      notes: ['3주차/노트-3주차.md'],
      instructions: '개념',
    });
    const saved = await call('save_summary', {
      dir: courseDir(),
      fromWeek: 3,
      content: '# 요약',
      instructions: '개념',
    });
    expect(text(saved)).toContain('요약을 저장했습니다');
    expect(await readFile(join(courseDir(), '요약-3주차.md'), 'utf8')).toContain('# 요약');
    const next = text(await call('list_summary', { course: '자료구조', toWeek: 3 }));
    expect(next).toContain('새로 만들 요약이 없습니다.');
    expect(next).toContain('최신 요약이라 건너뛴 과목: 1개');
  });

  it('노트 없는 주차만 있으면 노트를 먼저 만들지 묻는 안내를 담는다', async () => {
    const t = text(await call('list_summary', { course: '자료구조' }));
    expect(t).toContain('자료구조 · 전체 · 노트 필요');
    expect(t).toContain('노트 없는 주차가 있으면 승인 뒤 노트를 먼저 만들지 묻습니다.');
  });

  it('주차 범위를 거꾸로 주면 오류', async () => {
    for (const [name, args] of [
      ['list_summary', { fromWeek: 5, toWeek: 2 }],
      ['save_summary', { dir: courseDir(), fromWeek: 5, toWeek: 2, content: 'x' }],
    ] as const) {
      const r = await call(name, args);
      expect(r).toMatchObject({ isError: true });
      expect(text(r)).toContain('fromWeek 는 toWeek 보다 클 수 없습니다.');
    }
  });

  it('없는 과목이면 오류', async () => {
    const r = await call('list_summary', { course: '없는과목' });
    expect(r).toMatchObject({ isError: true });
    expect(text(r)).toContain('"없는과목" 과목을 찾지 못했습니다');
  });

  it('과목 폴더가 아니거나 범위에 노트가 없으면 요약을 쓰지 않는다', async () => {
    const notCourse = await call('save_summary', { dir: weekDir('3주차'), content: 'x' });
    expect(text(notCourse)).toContain('과목 폴더여야 합니다');
    const missing = await call('save_summary', { dir: join(courseDir(), '..', '없는과목'), content: 'x' });
    expect(text(missing)).toContain('과목 폴더여야 합니다');
    const noNotes = await call('save_summary', { dir: courseDir(), content: 'x' });
    expect(noNotes).toMatchObject({ isError: true });
    expect(text(noNotes)).toContain('요약할 노트가 없습니다');
  });
});
