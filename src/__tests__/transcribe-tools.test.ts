import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InMemoryTransport, LATEST_PROTOCOL_VERSION, type JSONRPCMessage } from '@modelcontextprotocol/server';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { TRANSCRIBE_QUEUE_MAX } from '../constants.js';
import { createServer } from '../server.js';
import { storageConfigFile } from '../storage.js';
import { writeTranscribeQueue } from '../transcribe/queue.js';
import { writeTranscribeState, type TranscribeState } from '../transcribe/state.js';
import { fakeLmsFetch } from './fixtures/lms-pages.js';

// 상태·대기열·잠금 경로는 import 시점에 homedir 로 정해진다 — 그 전에 테스트 전용 홈을 정한다
const home = vi.hoisted(() => ({
  dir: `${process.env.TMPDIR ?? '/tmp'}/dotbugi-transcribe-tools-${process.pid}`,
}));
vi.mock('node:os', async (orig) => ({ ...(await orig<typeof import('node:os')>()), homedir: () => home.dir }));

const getSession = vi.fn();
vi.mock('../session.js', () => ({ getSession: () => getSession() }));
vi.stubGlobal('fetch', vi.fn<typeof fetch>(fakeLmsFetch));

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
afterAll(async () => {
  await rm(home.dir, { recursive: true, force: true });
});

const call = (name: string, args: Record<string, unknown> = {}) => send('tools/call', { name, arguments: args });
const text = (result: Record<string, unknown>) => (result.content as { text: string }[])[0].text;
const running = (over: Partial<TranscribeState> = {}): TranscribeState => ({
  version: 1,
  status: 'running',
  cmid: 11,
  phase: 'transcribe',
  progress: 40,
  course: '자료구조',
  title: '트리 순회',
  path: null,
  // 살아 있는 pid (이 테스트 프로세스)
  pid: process.pid,
  updatedAt: new Date().toISOString(),
  language: 'auto',
  message: null,
  ...over,
});

beforeEach(async () => {
  await rm(home.dir, { recursive: true, force: true });
  await mkdir(join(home.dir, 'Downloads', 'dotbugi-mcp'), { recursive: true });
  getSession.mockResolvedValue({ session: 'abcdefghij0123456789', savedAt: '', method: 'extension' });
});

describe('transcribe_status', () => {
  it('기록이 없으면 그렇게 알리고 state 는 null', async () => {
    const r = await call('transcribe_status');
    expect(text(r)).toBe('STT 변환 기록이 없습니다.');
    expect(r.structuredContent).toMatchObject({ state: null, queue: { pending: [], finished: [], total: 0 } });
  });

  it('실행 중이면 단계·진행률·언어·대기열 위치와 끝난 강의를 보여 준다', async () => {
    await writeTranscribeState(running());
    await writeTranscribeQueue({
      version: 1,
      pending: [{ cmid: 12, language: 'auto' }],
      finished: [
        { cmid: 10, status: 'done', title: '스택' },
        { cmid: 9, status: 'error', title: null, message: '공개 전' },
      ],
    });
    const r = await call('transcribe_status');
    const t = text(r);
    expect(t).toContain('**STT ● 변환 중** 자료구조 트리 순회');
    expect(t).toContain('- 단계: STT 변환 중 `40%`');
    expect(t).toContain('- 언어: 자동 감지');
    expect(t).toContain('- 대기열: `3/4` (대기 `1`개)');
    expect(t).toContain('  - ✓ 완료 스택');
    expect(t).toContain('  - ✗ 오류 9 — 공개 전');
    expect(r.structuredContent).toMatchObject({ state: { stale: false }, queue: { position: 3, total: 4 } });
  });

  it('작업 프로세스가 없는데 실행 중으로 남았으면 멈춤으로 보여 준다', async () => {
    await writeTranscribeState(running({ pid: 2_147_483_646, phase: null, progress: null, language: 'Korean' }));
    const r = await call('transcribe_status');
    expect(text(r)).toContain('✗ 멈춤 (작업 프로세스 없음)');
    expect(text(r)).toContain('- 언어: Korean');
    expect(text(r)).not.toContain('단계');
    expect(r.structuredContent).toMatchObject({ state: { stale: true } });
  });

  it('끝난 작업은 결과 파일과 메시지를 보여 준다', async () => {
    const path = join(home.dir, 'STT-트리 순회.md');
    await writeTranscribeState(running({ status: 'done', phase: null, progress: null, path, message: '저장했습니다' }));
    const t = text(await call('transcribe_status'));
    expect(t).toContain('✓ 완료');
    expect(t).toContain(`- 결과 파일: \`${path}\``);
    expect(t).toContain('- 저장했습니다');
  });
});

describe('stop_transcribe', () => {
  it('실행 중인 작업이 없으면 그렇게 알린다', async () => {
    expect(text(await call('stop_transcribe'))).toBe('실행 중인 STT 변환이 없습니다.');
  });
});

describe('transcribe_lecture', () => {
  it('cmids·course·all 은 하나만 받는다 (all: false 는 지정 안 한 것)', async () => {
    const r = await call('transcribe_lecture', { cmids: [1], course: '자료구조' });
    expect(r).toMatchObject({ isError: true });
    expect(text(r)).toContain('하나만 넣으세요');
    // all: false 는 문제 없음 — 확인 창 대신 토큰을 돌려준다 (아직 시작하지 않음)
    const ok = text(await call('transcribe_lecture', { course: '자료구조', all: false }));
    expect(ok).toContain('confirmToken');
  });

  it('course 를 주면 결과 파일 없는 강의를 모아 확인을 받기 전에는 시작하지 않는다', async () => {
    const t = text(await call('transcribe_lecture', { course: '자료구조' }));
    expect(t).toContain('동영상 강의');
    expect(t).toContain('자료구조 · 8주차 · 트리 순회');
    expect(t).toContain('아직 아무것도 시작하지 않았습니다');
  });

  it('실행 중인 작업이 대기열을 채웠으면 확인 없이 가득 찼다고 알린다', async () => {
    await writeTranscribeState(running({ cmid: 99 }));
    await writeTranscribeQueue({
      version: 1,
      pending: Array.from({ length: TRANSCRIBE_QUEUE_MAX }, (_, i) => ({ cmid: 1000 + i, language: 'auto' as const })),
      finished: [],
    });
    const t = text(await call('transcribe_lecture', { course: '자료구조' }));
    expect(t).toContain('대기열이 가득 찼습니다');
  });

  it('저장 위치가 사라졌으면 대기열에 넣지 않고 오류', async () => {
    const gone = join(await mkdtemp(join(tmpdir(), 'dotbugi-gone-')), 'drive');
    await mkdir(join(home.dir, '.config', 'dotbugi-mcp'), { recursive: true });
    await writeFile(storageConfigFile(), JSON.stringify({ version: 1, root: gone }));
    try {
      const r = await call('transcribe_lecture', { cmids: [1] });
      expect(r).toMatchObject({ isError: true });
      expect(text(r)).toContain('찾을 수 없습니다');
    } finally {
      await rm(join(gone, '..'), { recursive: true, force: true });
    }
  });
});
