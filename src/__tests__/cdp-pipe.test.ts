import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { createFrameDecoder, encodeFrame } from '../login/cdp-frame.js';
import { createCdpClient } from '../login/cdp-pipe.js';

function setup(timeoutMs = 1000) {
  const toBrowser = new PassThrough();
  const fromBrowser = new PassThrough();
  const sent: { id: number; method: string }[] = [];
  toBrowser.on(
    'data',
    createFrameDecoder((raw) => sent.push(JSON.parse(raw) as { id: number; method: string }))
  );
  return { cdp: createCdpClient(toBrowser, fromBrowser, timeoutMs), fromBrowser, sent };
}

describe('createCdpClient', () => {
  it('id 로 응답을 짝지어 돌려준다', async () => {
    const { cdp, fromBrowser, sent } = setup();
    const result = cdp.send('Target.getTargets');
    await new Promise((r) => setImmediate(r));
    fromBrowser.write(encodeFrame({ id: sent[0].id, result: { targetInfos: [] } }));
    await expect(result).resolves.toEqual({ targetInfos: [] });
  });

  it('응답이 없으면 시간 제한으로 실패한다', async () => {
    const { cdp } = setup(20);
    await expect(cdp.send('Storage.getCookies')).rejects.toThrow('응답이 없습니다');
  });

  it('파이프가 닫히면 대기 중인 호출과 이후 호출이 실패한다', async () => {
    const { cdp, fromBrowser } = setup();
    const pending = cdp.send('Storage.getCookies');
    fromBrowser.end();
    fromBrowser.resume();
    await expect(pending).rejects.toThrow('연결이 끊겼습니다');
    await expect(cdp.send('Browser.close')).rejects.toThrow('연결이 끊겼습니다');
  });
});
