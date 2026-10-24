import { InMemoryTransport, LATEST_PROTOCOL_VERSION, type JSONRPCMessage } from '@modelcontextprotocol/server';
import { describe, expect, it } from 'vitest';
import { createServer } from '../server.js';

// SDK 인메모리 전송으로 JSON-RPC 요청을 보내고 같은 id 의 응답을 받는다
async function connect() {
  const [client, server] = InMemoryTransport.createLinkedPair();
  const pending = new Map<number, (result: Record<string, unknown>) => void>();
  client.onmessage = (msg: JSONRPCMessage) => {
    if ('id' in msg && 'result' in msg) pending.get(msg.id as number)?.(msg.result as Record<string, unknown>);
  };
  await createServer().connect(server);
  let id = 0;
  const send = (method: string, params?: Record<string, unknown>) =>
    new Promise<Record<string, unknown>>((resolve) => {
      pending.set(++id, resolve);
      void client.send({ jsonrpc: '2.0', id, method, params });
    });
  const init = await send('initialize', {
    protocolVersion: LATEST_PROTOCOL_VERSION,
    capabilities: {},
    clientInfo: { name: 'test', version: '0' },
  });
  await client.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  return { init, send };
}

describe('createServer', () => {
  it('initialize 요청에 서버 이름과 별칭이 담긴 안내로 응답한다', async () => {
    const { init } = await connect();
    expect(init).toMatchObject({ serverInfo: { name: 'dotbugi-mcp' } });
    // "dotbugi" 라고 하지 않아도 이 서버를 고르도록 별칭을 안내한다
    for (const alias of ['LMS', '이러닝', '돋부기', 'learn.hansung.ac.kr']) expect(init.instructions).toContain(alias);
  });

  it('안내에 적은 도구·프롬프트 이름은 모두 실제로 등록돼 있다', async () => {
    const { init, send } = await connect();
    const { tools } = (await send('tools/list')) as { tools: { name: string }[] };
    const { prompts } = (await send('prompts/list')) as { prompts: { name: string }[] };
    const registered = new Set([...tools, ...prompts].map((t) => t.name));
    const mentioned = String(init.instructions).match(/\b[a-z]+(?:_[a-z]+)+\b|\blog(?:in|out)\b/g) ?? [];
    expect(mentioned.length).toBeGreaterThan(10);
    for (const name of mentioned) expect(registered, name).toContain(name);
  });
});
