import { describe, expect, it } from 'vitest';
import { createFrameDecoder, encodeFrame } from '../login/cdp-frame.js';

describe('CDP 파이프 프레임', () => {
  it('JSON 뒤에 NUL 하나를 붙이고, 본문의 NUL 은 이스케이프된다', () => {
    const frame = encodeFrame({ id: 1, method: 'Browser.close', s: 'a\0b' });
    expect(frame.endsWith('\0')).toBe(true);
    expect(frame.slice(0, -1)).not.toContain('\0');
  });

  it('잘린 청크·여러 메시지·UTF-8 경계를 복원한다', () => {
    const got: unknown[] = [];
    const decode = createFrameDecoder((raw) => got.push(JSON.parse(raw)));
    const bytes = Buffer.from(encodeFrame({ id: 1, v: '한글' }) + encodeFrame({ id: 2 }) + '{"id":3');
    for (let i = 0; i < bytes.length; i++) decode(bytes.subarray(i, i + 1));
    expect(got).toEqual([{ id: 1, v: '한글' }, { id: 2 }]);
    decode(Buffer.from('}\0'));
    expect(got).toEqual([{ id: 1, v: '한글' }, { id: 2 }, { id: 3 }]);
  });
});
