import { Writable } from 'node:stream';
import { WriteStream } from 'node:tty';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { paint } from '../commands/paint.js';

// 색 판정용 가짜 스트림: 실제 Writable 에 터미널 여부와 실제 tty 의 색 판정(환경 변수 해석 포함)을 붙인다
const stream = (tty: boolean) =>
  Object.assign(new Writable({ write: (_c, _e, done) => done() }), {
    isTTY: tty,
    getColorDepth: WriteStream.prototype.getColorDepth,
    hasColors: WriteStream.prototype.hasColors,
  }) as unknown as NodeJS.WriteStream;

describe('paint', () => {
  beforeEach(() => {
    vi.stubEnv('FORCE_COLOR', undefined);
    vi.stubEnv('NO_COLOR', undefined);
    vi.stubEnv('NODE_DISABLE_COLORS', undefined);
    vi.stubEnv('TERM', 'xterm-256color');
  });
  afterEach(() => vi.unstubAllEnvs());

  it('터미널이면 색을 입힌다', () => {
    expect(paint('green', '완료', stream(true))).toBe('\x1b[32m완료\x1b[39m');
  });

  it('파이프(비TTY)면 평문', () => {
    expect(paint('green', '완료', stream(false))).toBe('완료');
  });

  it('NO_COLOR 면 터미널이어도 평문', () => {
    vi.stubEnv('NO_COLOR', '1');
    expect(paint('red', '오류', stream(true))).toBe('오류');
  });
});
