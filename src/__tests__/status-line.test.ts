import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PLAYER_STATE_MAX_BYTES, PLAYER_STATE_TEXT_MAX } from '../constants.js';
import { readPlayerState, type PlayerState } from '../player/state.js';
import { renderStatusLine } from '../player/status-line.js';

const NOW = Date.parse('2026-10-24T12:00:00+09:00');
const playing: PlayerState = {
  version: 1,
  status: 'playing',
  updatedAt: new Date(NOW - 30_000).toISOString(),
  total: 7,
  index: 3,
  current: { course: '초급일본어', title: '5과', week: 5, deadline: null, progress: 62, remainingSeconds: 700 },
  next: { course: '초급일본어', title: '6과', week: 6, deadline: '2026-10-25T23:59:59+09:00' },
  message: null,
};
const at = (minutesAgo: number) => new Date(NOW - minutesAgo * 60_000).toISOString();

describe('renderStatusLine', () => {
  it('재생 중이면 한 줄로 진도·남은 시간·다음 강의를 보여준다', () => {
    expect(renderStatusLine(playing, NOW)).toBe(
      '🎬 VOD 3/7 · 초급일본어 5과  ▓▓▓▓▓▓░░░░ 62%  12분 남음 · 다음: 6과 (D-1)'
    );
  });

  it('진도를 모르면 막대·남은 시간을 빼고 경고 메시지를 붙인다', () => {
    const state = { ...playing, current: { ...playing.current!, progress: null, remainingSeconds: null } };
    expect(renderStatusLine({ ...state, next: null, message: '진도 확인 실패' }, NOW)).toBe(
      '🎬 VOD 3/7 · 초급일본어 5과 · ⚠ 진도 확인 실패'
    );
  });

  it('재생 중인데 갱신이 끊기면 표시하고, 1시간 넘게 지나면 숨긴다', () => {
    expect(renderStatusLine({ ...playing, updatedAt: at(5) }, NOW)).toMatch(/· ⚠ 5분째 갱신 없음$/);
    expect(renderStatusLine({ ...playing, updatedAt: at(61) }, NOW)).toBe('');
  });

  it('다음 강의 D-day 는 한국 날짜 기준이고, 지난 마감은 마감으로 보여준다', () => {
    const line = (now: string, deadline: string) =>
      renderStatusLine({ ...playing, updatedAt: now, next: { ...playing.next!, deadline } }, Date.parse(now)).replace(
        /.*\(/,
        ''
      );
    expect(line('2026-10-24T23:59:59+09:00', '2026-10-25T00:00:01+09:00')).toBe('D-1)');
    expect(line('2026-10-25T00:00:00+09:00', '2026-10-25T23:59:59+09:00')).toBe('D-day)');
    expect(line('2026-10-26T00:00:00+09:00', '2026-10-25T23:59:59+09:00')).toBe('마감)');
  });

  it('updatedAt 이 미래(시계가 뒤로 감)면 갱신 이상으로 표시한다', () => {
    expect(renderStatusLine({ ...playing, updatedAt: at(-10) }, NOW)).toMatch(/· ⚠ 갱신 시각 이상$/);
  });

  it('오류는 짧게, 끝났거나 멈췄거나 상태가 없으면 아무것도 안 보여준다', () => {
    expect(renderStatusLine({ ...playing, status: 'error', message: '세션 만료' }, NOW)).toBe(
      '⚠ VOD 재생 오류: 세션 만료'
    );
    expect(renderStatusLine({ ...playing, status: 'error', message: '세션 만료', updatedAt: at(61) }, NOW)).toBe('');
    expect(renderStatusLine({ ...playing, status: 'done' }, NOW)).toBe('');
    expect(renderStatusLine({ ...playing, status: 'stopped' }, NOW)).toBe('');
    expect(renderStatusLine(null, NOW)).toBe('');
  });

  it('LMS 텍스트의 터미널 제어 문자(ANSI 이스케이프)를 지우고 길이를 자른다', () => {
    const evil = { ...playing.current!, title: '\x1b]0;pwn\x07\x1b[2J\u009b31m5과‮', course: 'x'.repeat(100) };
    const line = renderStatusLine({ ...playing, current: evil }, NOW);
    expect(line).not.toMatch(/[\p{Cc}\p{Cf}]/u);
    expect(line).toContain(`${'x'.repeat(29)}…`);
  });
});

describe('readPlayerState', () => {
  let root: string;
  let file: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'statusline-'));
    file = join(root, 'player-state.json');
  });
  afterEach(() => rm(root, { recursive: true, force: true }));

  it('올바른 상태 파일을 읽는다', async () => {
    await writeFile(file, JSON.stringify(playing));
    expect(readPlayerState(file)).toEqual(playing);
  });

  it('긴 글은 거부하지 않고 잘라서 읽는다', async () => {
    await writeFile(file, JSON.stringify({ ...playing, message: '가'.repeat(5000) }));
    expect(readPlayerState(file)?.message).toBe('가'.repeat(PLAYER_STATE_TEXT_MAX));
  });

  it('없거나 깨졌거나 스키마가 틀리거나 너무 크면 null', async () => {
    expect(readPlayerState(file)).toBeNull();
    await writeFile(file, '{"version":1,');
    expect(readPlayerState(file)).toBeNull();
    await writeFile(file, JSON.stringify({ ...playing, status: 'hacked' }));
    expect(readPlayerState(file)).toBeNull();
    // 공백만 덧붙인 올바른 JSON 이라도 크기 상한을 넘으면 읽지 않는다
    await writeFile(file, JSON.stringify(playing) + ' '.repeat(PLAYER_STATE_MAX_BYTES));
    expect(readPlayerState(file)).toBeNull();
  });

  it.skipIf(process.platform === 'win32')('심볼릭 링크는 따라가지 않는다', async () => {
    const target = join(root, 'other.json');
    await writeFile(target, JSON.stringify(playing));
    await symlink(target, file);
    expect(readPlayerState(file)).toBeNull();
  });
});
