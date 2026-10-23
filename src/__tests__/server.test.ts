import { InMemoryTransport, LATEST_PROTOCOL_VERSION, type JSONRPCMessage } from '@modelcontextprotocol/server';
import { describe, expect, it } from 'vitest';
import { createServer } from '../server.js';

describe('createServer', () => {
  it('initialize 요청에 서버 이름으로 응답한다', async () => {
    const [client, server] = InMemoryTransport.createLinkedPair();
    const response = new Promise<JSONRPCMessage>((resolve) => (client.onmessage = resolve));
    await createServer().connect(server);

    await client.send({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: LATEST_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: 'test', version: '0' },
      },
    });

    expect(await response).toMatchObject({ id: 1, result: { serverInfo: { name: 'dotbugi-mcp' } } });
  });
});
