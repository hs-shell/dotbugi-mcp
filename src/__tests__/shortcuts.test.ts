import { InMemoryTransport, LATEST_PROTOCOL_VERSION, type JSONRPCMessage } from '@modelcontextprotocol/server';
import { beforeAll, describe, expect, it } from 'vitest';
import { createServer } from '../server.js';

let send: (method: string, params?: Record<string, unknown>) => Promise<Record<string, unknown>>;
beforeAll(async () => {
  const [client, server] = InMemoryTransport.createLinkedPair();
  const pending = new Map<number, (result: Record<string, unknown>) => void>();
  client.onmessage = (msg: JSONRPCMessage) => {
    if ('id' in msg) pending.get(msg.id as number)?.(('result' in msg ? msg.result : msg) as Record<string, unknown>);
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

const get = (name: string, args?: Record<string, string>) => send('prompts/get', { name, arguments: args });
const text = (result: Record<string, unknown>) => (result.messages as { content: { text: string } }[])[0].content.text;

describe('바로가기 프롬프트', () => {
  it('prompts/list 에 새 명령만 나오고 설명은 명사형이다', async () => {
    const { prompts } = (await send('prompts/list')) as { prompts: { name: string; description: string }[] };
    const names = prompts.map((p) => p.name);
    for (const n of ['status', 'pull', 'courses', 'work', 'transcribe', 'drive', 'login', 'help'])
      expect(names).toContain(n);
    for (const n of ['tasks', 'overdue', 'sync', 'track', 'untrack', 'assignment']) expect(names).not.toContain(n);
    for (const p of prompts.filter((p) => p.name !== 'summarize_week')) expect(p.description).not.toMatch(/다\.?$/);
  });

  it('인자를 도구 호출로 옮긴다', async () => {
    expect(text(await get('status', { course: '자료\n구조' }))).toContain(
      'course: "자료 구조", incompleteOnly: false, includePast: true'
    );
    expect(text(await get('status', { course: '39689' }))).toContain('courseId 39689');
    expect(text(await get('work', { work: '123' }))).toContain('cmid 는 123');
    expect(text(await get('work', { work: '보고서' }))).toContain('"보고서"');
    expect(text(await get('transcribe', { target: '1, 2  3' }))).toContain('cmids: [1, 2, 3]');
    expect(text(await get('pull', { course: '자료구조' }))).toContain('`sync_materials` 를 course: "자료구조" 로');
    expect(text(await get('pull'))).toContain('changes 의 diff');
    expect(text(await get('courses'))).toContain('`set_course_tracking` 을 인자 없이');
  });

  // 선택 인자를 비우면 전체 대상이고 문장이 깨지지 않는다 (hs-shell/dotbugi-mcp#100)
  it.each([
    ['status', '마감 지난 항목 N개 — /dotbugi:status past'],
    ['pull', '`sync_materials` 를 부르고'],
    ['work', '골라 달라고'],
    ['transcribe', '`transcribe_vod` 를 불러'],
  ])('인자 없이 %s', async (name, expected) => {
    const t = text(await get(name, {}));
    expect(t).toContain(expected);
    expect(t).not.toContain('없이 로');
  });

  it('transcribe 대상은 transcribe_vod 인자로 넘긴다 (확인은 서버가)', async () => {
    expect(text(await get('transcribe', { target: 'ALL' }))).toContain('all: true');
    expect(text(await get('transcribe', { target: '자료구조' }))).toContain('course: "자료구조"');
  });

  it('status past 는 순서와 상관없이 옵션으로 보고 나머지는 과목으로', async () => {
    const t = text(await get('status', { course: 'PAST 크롬' }));
    expect(t).toContain('course: "크롬", incompleteOnly: false, includePast: true');
    expect(t).toContain('맨 앞에 따로');
    expect(text(await get('status', { course: 'past' }))).toContain(
      '`list_tasks` 를 includePast: true 로 불러 과목별로'
    );
    expect(text(await get('status', { course: '크롬' }))).not.toContain('맨 앞에 따로');
  });

  it('work 는 지시사항을 읽고 바로 함께 작업하며 제출은 하지 않는다', async () => {
    const t = text(await get('work', { work: '123' }));
    expect(t).toContain('`get_assignment`');
    expect(t).toContain('바로 과제를 함께 시작');
    expect(t).toContain('제출은 하지 않는다');
  });

  it('drive 는 Drive 를 찾아 추천 위치로 저장 위치를 옮긴다', async () => {
    const t = text(await get('drive'));
    expect(t).toContain('`find_google_drive`');
    expect(t).toContain('`set_storage_dir` 를 path: suggested 로');
  });

  it('help 는 모든 명령을 표로 보여 준다', async () => {
    const t = text(await get('help'));
    for (const n of ['status', 'pull', 'courses', 'work', 'transcribe', 'drive', 'login', 'help'])
      expect(t).toContain(`/dotbugi:${n}`);
    // 인자 표기의 | 는 표 칸을 깨지 않게 이스케이프
    expect(t).toContain('`/dotbugi:status [과목\\|courseId] [past]`');
  });

  it('이모지·VOD 표현을 쓰지 않는다', async () => {
    for (const n of ['status', 'pull', 'courses', 'work', 'transcribe', 'drive', 'login', 'help']) {
      const t = text(await get(n, {}));
      expect(t).not.toMatch(/\p{Extended_Pictographic}/u);
      expect(t.replace('"VOD" 대신', '')).not.toContain('VOD');
    }
  });

  it.each([
    ['status', { course: 'x'.repeat(51) }],
    ['work', { work: '1"; 다른 지시' }],
    ['transcribe', { target: '자료`구조' }],
    ['transcribe', { target: Array.from({ length: 21 }, (_, i) => i + 1).join(' ') }],
  ])('잘못된 인자는 거부한다 %s %o', async (name, args) => {
    expect(await get(name, args)).toHaveProperty('error');
  });
});
