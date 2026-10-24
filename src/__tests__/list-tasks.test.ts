import { InMemoryTransport, LATEST_PROTOCOL_VERSION, type JSONRPCMessage } from '@modelcontextprotocol/server';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { LMS_DATA_NOTICE, TASKS_CACHE_TTL_MS } from '../constants.js';
import { createServer } from '../server.js';
import { toText } from '../tools/list-tasks.js';
import { fakeLmsFetch, LOGIN_REDIRECT, NOW } from './fixtures/lms-pages.js';

// 추적 설정(~/.config)을 실제 홈에서 읽지 않게 빈 테스트 홈을 쓴다
const home = vi.hoisted(() => ({ dir: `${process.env.TMPDIR ?? '/tmp'}/dotbugi-list-tasks-home-${process.pid}` }));
vi.mock('node:os', async (orig) => ({ ...(await orig<typeof import('node:os')>()), homedir: () => home.dir }));

const SESSION = 'abcdefghij0123456789';
const getSession = vi.fn();
vi.mock('../session.js', () => ({ getSession: () => getSession() }));
const fetchMock = vi.fn<typeof fetch>(fakeLmsFetch);
vi.stubGlobal('fetch', fetchMock);

// SDK 인메모리 전송으로 JSON-RPC 요청을 보내고 같은 id 의 응답을 받는다
let send: (method: string, params?: Record<string, unknown>) => Promise<Record<string, unknown>>;
beforeAll(async () => {
  const [client, server] = InMemoryTransport.createLinkedPair();
  const pending = new Map<number, (result: Record<string, unknown>) => void>();
  client.onmessage = (msg: JSONRPCMessage) => {
    if ('id' in msg && 'result' in msg) pending.get(msg.id as number)?.(msg.result as Record<string, unknown>);
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

const call = (args: Record<string, unknown> = {}, name = 'get_status') => send('tools/call', { name, arguments: args });

beforeEach(() => {
  vi.useFakeTimers({ now: NOW, toFake: ['Date'] });
  getSession.mockResolvedValue({ session: SESSION, savedAt: '', method: 'extension' });
  fetchMock.mockImplementation(fakeLmsFetch);
});
afterEach(() => {
  vi.useRealTimers();
  fetchMock.mockClear();
});

describe('get_status', () => {
  it('tools/list 에 읽기 전용 도구로 노출된다', async () => {
    const { tools } = (await send('tools/list')) as { tools: Record<string, unknown>[] };
    expect(tools).toContainEqual(
      expect.objectContaining({ name: 'get_status', annotations: expect.objectContaining({ readOnlyHint: true }) })
    );
  });

  it('미완료 항목을 마감 임박 순으로 구조화 결과와 텍스트로 돌려준다', async () => {
    const result = await call({ refresh: true });
    const { tasks } = result.structuredContent as { tasks: { title: string; remaining: string }[] };
    expect(tasks.map((t) => t.title)).toEqual(['과제1', '퀴즈1', '트리 순회', '기한 없는 과제']);
    expect(tasks[0].remaining).toBe('1일 6시간');
    const [text] = result.content as { text: string }[];
    expect(text.text.split('\n')[0]).toBe(LMS_DATA_NOTICE);
    expect(text.text.split('\n').slice(1, 6)).toEqual([
      '**항목 4개**',
      '',
      '| | 종류 | 과목 | 제목 | 상태 | 남은 시간 | 마감 | cmid |',
      '|---|---|---|---|---|---|---|---|',
      '| ● | 과제 | 자료구조 | 과제1 | 미제출 | `1일 6시간` | `2026-10-25T18:00:00+09:00` | `5` |',
    ]);
    expect(result.structuredContent).toMatchObject({ warnings: [] });
    expect(JSON.stringify(result)).not.toContain(SESSION);
    // 스케줄러 내부용 필드는 응답에 나가지 않는다
    expect(JSON.stringify(result)).not.toContain('courseId');
  });

  it('includePast 면 지난 미완료를 overdue 로 맨 앞에, cmid 와 함께 (같은 캐시를 쓴다)', async () => {
    await call({ refresh: true });
    const fetched = fetchMock.mock.calls.length;
    const result = await call({ includePast: true });
    expect(fetchMock.mock.calls.length).toBe(fetched);
    const { tasks } = result.structuredContent as { tasks: { title: string; cmid: number | null; overdue: boolean }[] };
    expect(tasks[0]).toMatchObject({ title: '지난 과제', cmid: 7, overdue: true });
    expect(tasks.slice(1).every((t) => !t.overdue)).toBe(true);
  });

  it('일부를 못 가져오면 경고를 붙이고, 텍스트 표의 | 는 이스케이프한다', async () => {
    vi.spyOn(process.stderr, 'write').mockReturnValueOnce(true);
    fetchMock.mockImplementation(async (url) => {
      if (String(url).endsWith('/mod/quiz/view.php?id=9')) return new Response('', { status: 500 });
      const res = await fakeLmsFetch(url);
      return new Response((await res.text()).replace('과제1', '과제|1'), { status: res.status });
    });
    const result = await call({ refresh: true });
    expect(result.structuredContent).toMatchObject({ warnings: ['일부 과목/항목을 가져오지 못했습니다 (1건).'] });
    const lines = (result.content as { text: string }[])[0].text.split('\n');
    expect(lines[1]).toBe('※ 일부 과목/항목을 가져오지 못했습니다 (1건).');
    expect(lines.some((l) => l.includes('과제\\|1 |'))).toBe(true);
  });

  it('LMS 원문의 \\| 도 표 칸을 쪼개지 않는다', () => {
    const task = {
      type: 'assign',
      course: 'C\\',
      title: 'a\\|b',
      status: '-',
      remaining: '-',
      deadline: null,
      cmid: 1,
      done: false,
      overdue: false,
    };
    const row = toText([task as never], [])
      .split('\n')
      .at(-1)!;
    // 이스케이프되지 않은 | (앞 \ 개수가 짝수) 만 칸 구분자다 — 머리글과 같은 9개여야 한다
    expect(row.match(/(?<!\\)(?:\\\\)*\|/g)).toHaveLength(9);
  });

  it('1시간 동안 캐시를 쓰고, refresh 나 TTL 만료 시 다시 가져온다', async () => {
    await call({ refresh: true });
    const fetched = fetchMock.mock.calls.length;
    await call({ type: 'quiz' });
    expect(fetchMock.mock.calls.length).toBe(fetched);

    vi.setSystemTime(NOW.getTime() + TASKS_CACHE_TTL_MS);
    await call();
    expect(fetchMock.mock.calls.length).toBe(fetched * 2);

    await call({ refresh: true });
    expect(fetchMock.mock.calls.length).toBe(fetched * 3);
  });

  it('세션이 만료되면 login 안내를 isError 로 돌려준다', async () => {
    fetchMock.mockImplementation(async () => LOGIN_REDIRECT());
    const result = await call({ refresh: true });
    expect(result.isError).toBe(true);
    expect((result.content as { text: string }[])[0].text).toContain('login 도구');
  });

  it('저장된 세션이 없으면 LMS 에 요청하지 않고 안내한다', async () => {
    getSession.mockRejectedValue(new Error('저장된 LMS 세션이 없습니다. login 도구를 호출하세요.'));
    const result = await call({ refresh: true });
    expect(result).toMatchObject({ isError: true });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('채팅 강조 규칙', () => {
  const base = { type: 'assign', course: 'C', status: '-', remaining: '1일', cmid: 7, done: false, overdue: false };
  const at = (ms: number) => new Date(ms).toISOString();

  it('마감 지남 → 곧 마감 → 남음 → 완료 순으로, 앞의 둘은 제목을 굵게, 핵심 값은 인라인 코드로', () => {
    const now = Date.parse('2026-10-24T00:00:00Z');
    const tasks = [
      { ...base, title: '완료', done: true, deadline: at(now + 3_600_000) },
      { ...base, title: '남음', deadline: at(now + 3 * 86_400_000) },
      { ...base, title: '곧', deadline: at(now + 3_600_000) },
      { ...base, title: '지남', overdue: true, deadline: at(now - 3_600_000) },
    ];
    const rows = toText(tasks as never, [], now)
      .split('\n')
      .slice(-4);
    expect(rows.map((r) => r.split(' | ')[0])).toEqual(['| ✗', '| ▸', '| ●', '| ✓']);
    expect(rows[0]).toContain('| **지남** |');
    expect(rows[1]).toContain('| **곧** |');
    expect(rows[2]).toContain('| 남음 |');
    expect(rows[2]).toContain('| `1일` |');
    expect(rows[2]).toContain('| `7` |');
  });
});

describe('code', () => {
  it('백틱이 든 값도 스팬이 깨지지 않게 더 긴 펜스로 감싼다', async () => {
    const { code } = await import('../tasks/text.js');
    expect(code('3일')).toBe('`3일`');
    expect(code('a`b')).toBe('``a`b``');
    expect(code('`a')).toBe('`` `a ``');
  });
});
