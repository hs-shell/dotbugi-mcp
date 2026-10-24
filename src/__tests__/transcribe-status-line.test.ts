import { describe, expect, it } from 'vitest';
import { STATUSLINE_HIDE_AFTER_MS } from '../constants.js';
import type { TranscribeQueue } from '../transcribe/queue.js';
import type { TranscribeState } from '../transcribe/state.js';
import { renderTranscribeStatusLine } from '../transcribe/status-line.js';

const NOW = Date.parse('2026-10-24T12:00:00Z');
const state = (over: Partial<TranscribeState> = {}): TranscribeState => ({
  version: 1,
  status: 'running',
  cmid: 2,
  phase: 'transcribe',
  progress: 42,
  course: '데이터베이스',
  title: '3주차',
  path: null,
  pid: 1234,
  updatedAt: new Date(NOW - 1000).toISOString(),
  message: null,
  ...over,
});
const queue = (pending = 0, finished: TranscribeQueue['finished'] = []): TranscribeQueue => ({
  version: 1,
  pending: Array.from({ length: pending }, (_, i) => ({ cmid: 10 + i, language: 'auto' as const })),
  finished,
});
const render = (s: TranscribeState | null, q = queue(), alive = true) =>
  renderTranscribeStatusLine(s, q, NOW, () => alive);

describe('renderTranscribeStatusLine', () => {
  it('실행 중이면 몇 번째/전체·과목·제목·진행 막대를 한 줄로', () => {
    expect(render(state(), queue(3, [{ cmid: 1, status: 'done', title: null }]))).toBe(
      '받아쓰기 2/5 ▸ 데이터베이스 3주차 ▓▓▓░░░░░ 42%'
    );
    // 하나뿐이면 개수를 빼고, 받아쓰기 전 단계는 단계 이름만
    expect(render(state({ phase: 'download', progress: null }))).toBe('받아쓰기 ▸ 데이터베이스 3주차 영상 받는 중');
  });

  it('이모지 없이 기호만 쓴다', () => {
    const lines = [
      render(state()),
      render(state({ status: 'done' })),
      render(state({ status: 'error' })),
      render(state({ status: 'stopped' })),
    ];
    for (const l of lines) expect(l).not.toMatch(/\p{Extended_Pictographic}/u);
  });

  it('LMS 글의 제어·이스케이프 문자를 지우고 길이를 자른다', () => {
    const line = render(state({ course: '\u001b[31m빨강\u001b[0m', title: 'x'.repeat(100) }));
    expect(line).not.toContain('\u001b');
    expect(line).toContain('…');
  });

  it('프로세스가 없거나 갱신이 끊긴 running 은 숨긴다', () => {
    expect(render(state(), queue(), false)).toBe('');
    expect(render(state({ updatedAt: new Date(NOW - 60 * 60_000).toISOString() }))).toBe('');
    expect(render(null)).toBe('');
  });

  it('끝나면 잠시 결과를 보여 주고 시간이 지나면 숨긴다', () => {
    const done = state({ status: 'done', phase: null, progress: 100 });
    expect(render(done)).toBe('✓ 받아쓰기 끝');
    expect(
      render(
        done,
        queue(0, [
          { cmid: 1, status: 'error', title: null },
          { cmid: 2, status: 'done', title: null },
        ])
      )
    ).toBe('✓ 받아쓰기 끝 2개 (실패 1)');
    expect(render(state({ status: 'error', message: '세션 만료' }))).toBe('✗ 받아쓰기 오류: 세션 만료');
    expect(render(state({ status: 'stopped' }))).toBe('○ 받아쓰기 중지');
    expect(render({ ...done, updatedAt: new Date(NOW - STATUSLINE_HIDE_AFTER_MS).toISOString() })).toBe('');
  });
});
