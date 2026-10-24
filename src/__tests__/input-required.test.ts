import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InMemoryTransport, type JSONRPCMessage } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer } from '../server.js';

// 2026-07-28 세대(요청마다 _meta 로 클라이언트 정보를 싣고 initialize 가 없음) 연결 — Claude Code v2 런타임이 쓰는 방식 (#160)
const meta = (capabilities: Record<string, unknown>) => ({
  'io.modelcontextprotocol/protocolVersion': '2026-07-28',
  'io.modelcontextprotocol/clientCapabilities': capabilities,
  'io.modelcontextprotocol/clientInfo': { name: 'test', version: '0' },
});

let dir: string;
let close: () => Promise<void>;
let call: (params: Record<string, unknown>) => Promise<Record<string, unknown>>;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'dotbugi-mrtr-'));
  vi.stubEnv('CLAUDE_CONFIG_DIR', dir);
  const [client, server] = InMemoryTransport.createLinkedPair();
  const pending = new Map<number, (result: Record<string, unknown>) => void>();
  client.onmessage = (msg: JSONRPCMessage) => {
    if ('id' in msg && 'result' in msg) pending.get(msg.id as number)?.(msg.result as Record<string, unknown>);
  };
  await client.start();
  close = serveStdio(createServer, { transport: server }).close;
  let id = 0;
  call = (params) =>
    new Promise((resolve) => {
      pending.set(++id, resolve);
      void client.send({ jsonrpc: '2.0', id, method: 'tools/call', params });
    });
});
afterEach(async () => {
  await close();
  vi.unstubAllEnvs();
  await rm(dir, { recursive: true, force: true });
});

const statusline = (capabilities: Record<string, unknown>, inputResponses?: Record<string, unknown>) =>
  call({
    name: 'setup_statusline',
    arguments: { action: 'enable' },
    _meta: meta(capabilities),
    ...(inputResponses && { inputResponses }),
  });
const settings = () => readFile(join(dir, 'settings.json'), 'utf8');

describe('2026-07-28 세대 확인 창 (input_required)', () => {
  it('확인 창을 요청하고, 같은 호출에 승인이 실려 오면 실행한다', async () => {
    const first = await statusline({ elicitation: { form: {} } });
    expect(first.resultType).toBe('input_required');
    const [key, request] = Object.entries(first.inputRequests as Record<string, { method: string }>)[0];
    expect(request.method).toBe('elicitation/create');
    await expect(settings()).rejects.toThrow();

    const second = await statusline({ elicitation: { form: {} } }, { [key]: { action: 'accept', content: {} } });
    expect(second.resultType).toBe('complete');
    expect(JSON.parse(await settings())).toHaveProperty('statusLine');
  });

  it('거절이 실려 오면 실행하지 않는다', async () => {
    const first = await statusline({ elicitation: { form: {} } });
    const key = Object.keys(first.inputRequests as object)[0];
    const second = await statusline({ elicitation: { form: {} } }, { [key]: { action: 'decline' } });
    expect((second.content as { text: string }[])[0].text).toContain('거절');
    await expect(settings()).rejects.toThrow();
  });

  it('다른 창의 키로 실린 답은 쓰지 않고 다시 묻는다 (승인 재사용 방지)', async () => {
    const second = await statusline(
      { elicitation: { form: {} } },
      { 'confirm-0000000000000000': { action: 'accept' } }
    );
    expect(second.resultType).toBe('input_required');
    await expect(settings()).rejects.toThrow();
  });

  it('elicitation 을 선언하지 않은 클라이언트에는 확인 토큰 방식으로 답한다', async () => {
    const first = await statusline({});
    expect(first.resultType).toBe('complete');
    expect((first.content as { text: string }[])[0].text).toContain('confirmToken');
  });
});
