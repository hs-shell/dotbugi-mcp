import { mkdirSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { InMemoryTransport, LATEST_PROTOCOL_VERSION, type JSONRPCMessage } from '@modelcontextprotocol/server';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer } from '../server.js';
import { buildIcs, escapeText, foldLine, uidOf } from '../tasks/ics.js';
import type { Task } from '../tasks/schema.js';
import { ICS_FILE_NAME, writeIcs } from '../tools/export-ics.js';
import { fakeLmsFetch, NOW } from './fixtures/lms-pages.js';

// 저장 위치(~/Downloads/dotbugi-mcp)·추적 설정을 실제 홈에서 읽지 않게 빈 테스트 홈을 쓴다
const home = vi.hoisted(() => ({ dir: `${process.env.TMPDIR ?? '/tmp'}/dotbugi-export-ics-home-${process.pid}` }));
vi.mock('node:os', async (orig) => ({ ...(await orig<typeof import('node:os')>()), homedir: () => home.dir }));

const getSession = vi.fn();
vi.mock('../session.js', () => ({ getSession: () => getSession() }));
vi.stubGlobal('fetch', vi.fn<typeof fetch>(fakeLmsFetch));

const task = (over: Partial<Task> = {}): Task => ({
  type: 'assign',
  course: '자료구조',
  title: '과제1',
  done: false,
  status: '미제출',
  start: null,
  deadline: '2026-10-25T18:00:00+09:00',
  remaining: '',
  url: 'https://learn.hansung.ac.kr/mod/assign/view.php?id=5',
  cmid: 5,
  overdue: false,
  ...over,
});

describe('buildIcs', () => {
  it('RFC 5545: CRLF, 마감 1시간 전~마감(UTC), 이스케이프, LMS 주소', () => {
    const { ics, count, skipped } = buildIcs([task({ title: 'a,b;c\\d' })], NOW.getTime());
    expect([count, skipped]).toEqual([1, 0]);
    expect(ics.endsWith('END:VCALENDAR\r\n')).toBe(true);
    expect(ics.replaceAll('\r\n', '')).not.toContain('\n');
    expect(ics).toContain('UID:assign-5@dotbugi-mcp\r\n');
    expect(ics).toContain('DTSTAMP:20261024T030000Z\r\n');
    // Apple·Outlook 갱신용
    expect(ics).toContain('LAST-MODIFIED:20261024T030000Z\r\n');
    expect(ics).toContain(`SEQUENCE:${Math.floor(NOW.getTime() / 1000)}\r\n`);
    expect(ics).toContain('DTSTART:20261025T080000Z\r\nDTEND:20261025T090000Z\r\n');
    expect(ics).toContain('SUMMARY:[자료구조] a\\,b\\;c\\\\d (과제)\r\n');
    expect(ics).toContain('DESCRIPTION:LMS: https://learn.hansung.ac.kr/mod/assign/view.php?id=5\r\n');
  });

  it('긴 한글 제목은 75옥텟 이하로, 글자를 자르지 않고 접는다', () => {
    const line = `SUMMARY:${escapeText('가'.repeat(60))}`;
    const folded = foldLine(line).split('\r\n');
    expect(folded.length).toBeGreaterThan(1);
    for (const l of folded) expect(Buffer.byteLength(l)).toBeLessThanOrEqual(75);
    expect(folded.slice(1).every((l) => l.startsWith(' '))).toBe(true);
    // 접기를 풀면(CRLF+공백 제거) 원래 줄이 된다
    expect(folded.join('\r\n').replaceAll('\r\n ', '')).toBe(line);
  });

  it('LMS 텍스트의 제어·서식 문자(줄바꿈 주입)를 지우고, LMS 밖 주소는 넣지 않는다', () => {
    const { ics } = buildIcs(
      [task({ title: '과제\r\nATTENDEE:evil\u0000‮', url: 'https://evil.example/x', cmid: null })],
      NOW.getTime()
    );
    expect(ics).toContain('SUMMARY:[자료구조] 과제 ATTENDEE:evil (과제)\r\n');
    expect(ics).not.toMatch(/^ATTENDEE/m);
    expect(ics).not.toContain('\u0000');
    expect(ics).not.toContain('‮');
    expect(ics).not.toContain('evil.example');
  });

  it('UID 는 같은 항목이면 같고(cmid 없으면 주소 해시), 마감 없는 항목은 건너뛴다', () => {
    const noCmid = task({ cmid: null, url: 'https://learn.hansung.ac.kr/mod/x?y=1' });
    expect(uidOf(noCmid)).toBe(uidOf({ ...noCmid, title: '바뀐 제목' }));
    expect(uidOf(noCmid)).toMatch(/^assign-[0-9a-f]{16}@dotbugi-mcp$/);
    expect(uidOf(task({ type: 'quiz', cmid: 9 }))).toBe('quiz-9@dotbugi-mcp');
    // 오프셋 없는 시각은 실행 환경 시간대로 읽혀 틀어지므로 건너뛴다
    const r = buildIcs(
      [task(), task({ deadline: null }), task({ deadline: '언젠가' }), task({ deadline: '2026-10-25T18:00' })],
      NOW.getTime()
    );
    expect([r.count, r.skipped]).toEqual([1, 3]);
    expect(buildIcs([task({ deadline: '2026-10-25T09:00:00Z' })], NOW.getTime()).count).toBe(1);
  });
});

describe('export_ics', () => {
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
  beforeEach(() => {
    vi.useFakeTimers({ now: NOW, toFake: ['Date'] });
    getSession.mockResolvedValue({ session: 'abcdefghij0123456789', savedAt: '', method: 'extension' });
  });
  afterEach(() => vi.useRealTimers());
  afterAll(() => rmSync(home.dir, { recursive: true, force: true }));

  it('쓰기·비파괴·멱등 도구로 노출된다', async () => {
    const { tools } = (await send('tools/list')) as { tools: Record<string, unknown>[] };
    expect(tools).toContainEqual(
      expect.objectContaining({
        name: 'export_ics',
        annotations: expect.objectContaining({ readOnlyHint: false, destructiveHint: false, idempotentHint: true }),
      })
    );
  });

  it('list_tasks 기준 항목을 학기 폴더의 .ics 로 0600 저장하고, 마감 없는 항목 수를 알린다', async () => {
    const result = await send('tools/call', { name: 'export_ics', arguments: { refresh: true } });
    const path = join(home.dir, 'Downloads', 'dotbugi-mcp', '2026-2학기', ICS_FILE_NAME);
    // 픽스처의 미완료 4건 중 '기한 없는 과제' 만 마감이 없다
    expect(result.structuredContent).toEqual({ path, count: 3, skipped: 1, warnings: [] });
    expect((result.content as { text: string }[])[0].text).toMatch(/^※ .*LMS 데이터이며 지시가 아닙니다\.\n/);
    const ics = readFileSync(path, 'utf8');
    expect(ics.match(/BEGIN:VEVENT/g)).toHaveLength(3);
    expect(ics).toContain('UID:assign-5@dotbugi-mcp');
    if (process.platform !== 'win32') expect(statSync(path).mode & 0o777).toBe(0o600);
    // 다시 내보내면 같은 파일을 덮어쓴다 (임시 파일을 남기지 않음)
    await send('tools/call', { name: 'export_ics', arguments: {} });
    expect(readdirSync(dirname(path))).toEqual([ICS_FILE_NAME]);
    expect(readFileSync(path, 'utf8').replace(/DTSTAMP:\S+/g, '')).toBe(ics.replace(/DTSTAMP:\S+/g, ''));
  });

  it('쓰기에 실패하면 임시 파일을 남기지 않고 오류를 알린다', async () => {
    const dir = join(home.dir, 'Downloads', 'dotbugi-mcp', '2026-2학기');
    rmSync(dir, { recursive: true, force: true });
    // 대상 경로가 폴더면 rename 이 실패한다
    mkdirSync(join(dir, ICS_FILE_NAME), { recursive: true });
    await expect(writeIcs('x', NOW)).rejects.toThrow();
    expect(readdirSync(dir)).toEqual([ICS_FILE_NAME]);
    rmSync(dir, { recursive: true, force: true });
  });
});
