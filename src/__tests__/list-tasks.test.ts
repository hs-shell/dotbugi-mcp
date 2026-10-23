import { rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { InMemoryTransport, LATEST_PROTOCOL_VERSION, type JSONRPCMessage } from '@modelcontextprotocol/server';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { TASKS_CACHE_TTL_MS } from '../constants.js';
import { PLAYER_STATE_FILE } from '../player/state.js';
import { createServer } from '../server.js';
import { fakeLmsFetch, LOGIN_REDIRECT, NOW } from './fixtures/lms-pages.js';

const SESSION = 'abcdefghij0123456789';
const getSession = vi.fn();
vi.mock('../session.js', () => ({ getSession: () => getSession() }));
const fetchMock = vi.fn<typeof fetch>(fakeLmsFetch);
vi.stubGlobal('fetch', fetchMock);
// vod_status 가 읽는 play 상태 파일을 임시 경로로 돌린다
vi.mock('../player/state.js', async (importOriginal) => {
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'vod-status-'));
  return { ...(await importOriginal<object>()), PLAYER_STATE_FILE: join(dir, 'player-state.json') };
});

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

const call = (args: Record<string, unknown> = {}, name = 'list_tasks') => send('tools/call', { name, arguments: args });

beforeEach(() => {
  vi.useFakeTimers({ now: NOW, toFake: ['Date'] });
  getSession.mockResolvedValue({ session: SESSION, savedAt: '', method: 'extension' });
  fetchMock.mockImplementation(fakeLmsFetch);
});
afterEach(() => {
  vi.useRealTimers();
  fetchMock.mockClear();
  rmSync(PLAYER_STATE_FILE, { force: true });
});
afterAll(() => rmSync(dirname(PLAYER_STATE_FILE), { recursive: true, force: true }));

describe('list_tasks', () => {
  it('tools/list 에 읽기 전용 도구로 노출된다', async () => {
    const { tools } = (await send('tools/list')) as { tools: Record<string, unknown>[] };
    expect(tools).toContainEqual(
      expect.objectContaining({ name: 'list_tasks', annotations: expect.objectContaining({ readOnlyHint: true }) })
    );
  });

  it('미완료 항목을 마감 임박 순으로 구조화 결과와 텍스트로 돌려준다', async () => {
    const result = await call({ refresh: true });
    const { tasks } = result.structuredContent as { tasks: { title: string; remaining: string }[] };
    expect(tasks.map((t) => t.title)).toEqual(['과제1', '퀴즈1', '트리 순회', '기한 없는 과제']);
    expect(tasks[0].remaining).toBe('1일 6시간');
    const [text] = result.content as { text: string }[];
    expect(text.text.split('\n')[0]).toBe('[과제] 자료구조 | 과제1 | 미제출 | 1일 6시간 | 2026-10-25T18:00:00+09:00');
    expect(result.structuredContent).toMatchObject({ warnings: [] });
    expect(JSON.stringify(result)).not.toContain(SESSION);
    // 스케줄러 내부용 필드는 응답에 나가지 않는다
    expect(JSON.stringify(result)).not.toContain('courseId');
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
    expect(lines[0]).toBe('일부 과목/항목을 가져오지 못했습니다 (1건).');
    expect(lines[1]).toContain('과제\\|1 |');
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
    expect((result.content as { text: string }[])[0].text).toContain('dotbugi-mcp login');
  });

  it('저장된 세션이 없으면 LMS 에 요청하지 않고 안내한다', async () => {
    getSession.mockRejectedValue(new Error('저장된 LMS 세션이 없습니다. 터미널에서 dotbugi-mcp login 을 실행하세요.'));
    const result = await call({ refresh: true });
    expect(result).toMatchObject({ isError: true });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('vod_status', () => {
  it('남은 VOD 만 돌려주고, 재생 상태 파일이 없으면 player 는 null', async () => {
    const result = await call({ refresh: true }, 'vod_status');
    const { tasks, player } = result.structuredContent as { tasks: { type: string; title: string }[]; player: null };
    expect(tasks.map((t) => [t.type, t.title])).toEqual([['vod', '트리 순회']]);
    expect(player).toBeNull();
    expect((result.content as { text: string }[])[0].text).toMatch(/^\[강의\] .*트리 순회/);
  });

  it('재생 중이면 지금 강의의 진도와 상태 표시줄 한 줄을 붙인다', async () => {
    const state = {
      version: 1,
      status: 'playing',
      updatedAt: new Date(NOW.getTime() - 60_000).toISOString(),
      total: 1,
      index: 1,
      current: { course: '자료구조', title: '트리 순회', week: 8, deadline: null, progress: 40, remainingSeconds: 600 },
      next: null,
      message: null,
    };
    writeFileSync(PLAYER_STATE_FILE, JSON.stringify(state));
    const result = await call({}, 'vod_status');
    expect(result.structuredContent).toMatchObject({ player: { ...state, stale: false } });
    const lines = (result.content as { text: string }[])[0].text.split('\n');
    expect(lines[0]).toBe('🎬 VOD 1/1 · 자료구조 트리 순회  ▓▓▓▓░░░░░░ 40%  10분 남음');
    expect(lines[1]).toContain('트리 순회');
  });
});
