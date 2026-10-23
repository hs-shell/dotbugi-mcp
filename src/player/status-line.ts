import { PLAYER_STATE_STALE_MS, STATUSLINE_HIDE_AFTER_MS } from '../constants.js';
import { deadlineMs } from '../tasks/time.js';
import { clean } from '../tasks/text.js';
import type { PlayerState } from './state.js';

const MS_PER_DAY = 24 * 60 * 60_000;
// LMS_UTC_OFFSET(+09:00) 과 같은 값
const OFFSET_MS = 9 * 60 * 60_000;
const BAR_WIDTH = 10;
const TEXT_MAX = 30;

// 상태 파일 텍스트는 LMS 출처라 터미널로 가기 전 제어·서식 문자(ANSI 이스케이프 포함)를 지우고 길이를 자른다
const show = (text: string) => {
  const chars = [...clean(text)];
  return chars.length > TEXT_MAX ? `${chars.slice(0, TEXT_MAX - 1).join('')}…` : chars.join('');
};

const minutes = (seconds: number) => {
  const m = Math.ceil(seconds / 60);
  return m >= 60 ? `${Math.floor(m / 60)}시간 ${m % 60}분` : `${m}분`;
};

// 한국 날짜 기준 남은 일수 (LMS 마감은 한국 시간)
function dDay(deadline: string | null, now: number): string | null {
  const ms = deadlineMs(deadline);
  if (Number.isNaN(ms)) return null;
  const days = Math.floor((ms + OFFSET_MS) / MS_PER_DAY) - Math.floor((now + OFFSET_MS) / MS_PER_DAY);
  // formatRemaining 과 같이 지난 마감은 '마감'
  if (days < 0) return '마감';
  return days === 0 ? 'D-day' : `D-${days}`;
}

// 재생 중인데 갱신이 끊김. 미래 시각(시계가 뒤로 감)도 믿을 수 없어 끊긴 것으로 본다
export function isStale(state: PlayerState, now: number): boolean {
  const age = now - Date.parse(state.updatedAt);
  return state.status === 'playing' && (age > PLAYER_STATE_STALE_MS || age < 0);
}

// 표시할 게 없으면 빈 문자열. 예) 🎬 VOD 3/7 · 초급일본어 5과  ▓▓▓▓▓▓░░░░ 62%  12분 남음 · 다음: 6과 (D-1)
export function renderStatusLine(state: PlayerState | null, now: number): string {
  if (!state) return '';
  const age = now - Date.parse(state.updatedAt);
  if (!(age < STATUSLINE_HIDE_AFTER_MS)) return '';
  if (state.status === 'error') return `⚠ VOD 재생 오류${state.message ? `: ${show(state.message)}` : ''}`;
  if (state.status !== 'playing') return '';

  const parts = [`🎬 VOD ${state.index}/${state.total}`];
  const { current, next } = state;
  if (current) {
    parts.push(` · ${show(current.course)} ${show(current.title)}`);
    if (current.progress !== null) {
      const filled = Math.round((current.progress / 100) * BAR_WIDTH);
      parts.push(`  ${'▓'.repeat(filled)}${'░'.repeat(BAR_WIDTH - filled)} ${current.progress}%`);
    }
    if (current.remainingSeconds !== null) parts.push(`  ${minutes(current.remainingSeconds)} 남음`);
  }
  if (next) {
    const d = dDay(next.deadline, now);
    parts.push(` · 다음: ${show(next.title)}${d ? ` (${d})` : ''}`);
  }
  if (isStale(state, now))
    parts.push(age < 0 ? ' · ⚠ 갱신 시각 이상' : ` · ⚠ ${Math.floor(age / 60_000)}분째 갱신 없음`);
  else if (state.message) parts.push(` · ⚠ ${show(state.message)}`);
  return parts.join('');
}
