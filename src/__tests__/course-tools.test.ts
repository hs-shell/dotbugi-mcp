import { readFile, rm } from 'node:fs/promises';
import { InMemoryTransport, LATEST_PROTOCOL_VERSION, type JSONRPCMessage } from '@modelcontextprotocol/server';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { COURSE_FILTER_MAX_LENGTH } from '../constants.js';
import { createServer } from '../server.js';
import { COURSES_FILE } from '../tasks/courses.js';
import { fakeLmsFetch, NOW } from './fixtures/lms-pages.js';

// 추적 설정(~/.config)을 실제 홈에 쓰지 않게 테스트 홈을 쓴다
const home = vi.hoisted(() => ({ dir: `${process.env.TMPDIR ?? '/tmp'}/dotbugi-course-tools-home-${process.pid}` }));
vi.mock('node:os', async (orig) => ({ ...(await orig<typeof import('node:os')>()), homedir: () => home.dir }));

const SESSION = 'abcdefghij0123456789';
const getSession = vi.fn();
vi.mock('../session.js', () => ({ getSession: () => getSession() }));
const fetchMock = vi.fn<typeof fetch>(fakeLmsFetch);
vi.stubGlobal('fetch', fetchMock);

// 결과와 JSON-RPC 오류(입력 검증 실패 등) 모두 같은 id 로 받는다
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
  await send('initialize', {
    protocolVersion: LATEST_PROTOCOL_VERSION,
    capabilities: {},
    clientInfo: { name: 'test', version: '0' },
  });
  await client.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
});

const call = (name: string, args: Record<string, unknown> = {}) => send('tools/call', { name, arguments: args });
const text = (result: Record<string, unknown>) => (result.content as { text: string }[])[0].text;
const readConfig = async () => JSON.parse(await readFile(COURSES_FILE, 'utf8')) as unknown;
// 운영체제 → 자료구조 실습: '자료구조' 가 두 강좌에 맞게 한다
const ambiguousFetch = async (url: string | URL | Request) => {
  const res = await fakeLmsFetch(url);
  return new Response((await res.text()).replace('운영체제', '자료구조 실습'), { status: res.status });
};

beforeEach(async () => {
  vi.useFakeTimers({ now: NOW, toFake: ['Date'] });
  await rm(home.dir, { recursive: true, force: true });
  getSession.mockResolvedValue({ session: SESSION, savedAt: '', method: 'extension' });
  fetchMock.mockImplementation(fakeLmsFetch);
});
afterEach(() => {
  vi.useRealTimers();
  fetchMock.mockClear();
});

describe('list_courses', () => {
  it('읽기 전용, set_course_tracking 은 쓰기·멱등·비파괴로 노출된다', async () => {
    const { tools } = (await send('tools/list')) as { tools: { name: string; annotations: object }[] };
    expect(tools.find((t) => t.name === 'list_courses')?.annotations).toMatchObject({ readOnlyHint: true });
    expect(tools.find((t) => t.name === 'set_course_tracking')?.annotations).toMatchObject({
      readOnlyHint: false,
      idempotentHint: true,
      destructiveHint: false,
    });
  });

  it('강좌별 id·과목명·종류·추적 여부와 직접 정한 값인지를 돌려준다', async () => {
    await call('set_course_tracking', { course: '300', tracked: true });
    const result = await call('list_courses');
    expect(result.structuredContent).toEqual({
      courses: [
        { courseId: '100', title: '자료구조', kind: '정규', tracked: true, explicit: false },
        { courseId: '200', title: '운영체제', kind: '정규', tracked: true, explicit: false },
        { courseId: '300', title: '비교과 활동', kind: '비교과', tracked: true, explicit: true },
      ],
    });
    expect(text(result).split('\n')[0]).toBe('켜짐(기본) | 100 | 자료구조 | 정규');
    expect(JSON.stringify(result)).not.toContain(SESSION);
  });

  it('세션이 없으면 LMS 에 요청하지 않고 login 안내를 isError 로', async () => {
    getSession.mockRejectedValue(new Error('저장된 LMS 세션이 없습니다. login 도구를 호출하세요.'));
    const result = await call('list_courses');
    expect(result.isError).toBe(true);
    expect(text(result)).toContain('login');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('set_course_tracking', () => {
  it('하나만 맞으면 저장하고 새 상태를 돌려준다', async () => {
    const result = await call('set_course_tracking', { course: '자료구조', tracked: false });
    expect(result.structuredContent).toEqual({
      saved: true,
      courses: [{ courseId: '100', title: '자료구조', kind: '정규', tracked: false, explicit: true }],
    });
    expect(await readConfig()).toEqual({ version: 1, courses: { '100': false } });
  });

  it('여러 개 맞으면 저장하지 않고 후보를 돌려준다', async () => {
    fetchMock.mockImplementation(ambiguousFetch);
    const result = await call('set_course_tracking', { course: '자료구조', tracked: false });
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toMatchObject({
      saved: false,
      courses: [{ courseId: '100' }, { courseId: '200', title: '자료구조 실습' }],
    });
    await expect(readFile(COURSES_FILE)).rejects.toThrow();
    // courseId 로 다시 지정하면 저장된다
    await call('set_course_tracking', { course: '200', tracked: false });
    expect(await readConfig()).toEqual({ version: 1, courses: { '200': false } });
  });

  it('맞는 강좌가 없으면 오류, 저장하지 않는다', async () => {
    const result = await call('set_course_tracking', { course: '없는과목', tracked: true });
    expect(result.isError).toBe(true);
    expect(text(result)).toContain('일치하는 강좌가 없습니다');
    await expect(readFile(COURSES_FILE)).rejects.toThrow();
  });

  it('빈 값·공백·너무 긴 query 는 LMS 요청 전에 거부한다', async () => {
    for (const course of ['', '   ', 'x'.repeat(COURSE_FILTER_MAX_LENGTH + 1)]) {
      const result = await call('set_course_tracking', { course, tracked: true });
      expect(result.isError ?? result.rpcError).toBeTruthy();
    }
    expect(getSession).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('바꾸면 list_tasks 캐시를 쓰지 않고 다시 가져온다', async () => {
    const before = await call('list_tasks', { refresh: true });
    expect(JSON.stringify(before.structuredContent)).toContain('자료구조');
    await call('set_course_tracking', { course: '100', tracked: false });
    const fetched = fetchMock.mock.calls.length;
    const after = await call('list_tasks');
    expect(fetchMock.mock.calls.length).toBeGreaterThan(fetched);
    expect(JSON.stringify(after.structuredContent)).not.toContain('자료구조');
  });
});
