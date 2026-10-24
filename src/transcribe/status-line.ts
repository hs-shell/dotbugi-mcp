import { styleText } from 'node:util';
import { STATUSLINE_HIDE_AFTER_MS } from '../constants.js';
import { clean } from '../tasks/text.js';
import { queuePosition, type TranscribeQueue } from './queue.js';
import { isTranscribeStale, TRANSCRIBE_PHASE_LABELS, type TranscribeState } from './state.js';

const BAR_WIDTH = 8;
const TEXT_MAX = 30;

// 상태 파일 글(과목·제목·메시지)은 LMS 출처라 터미널로 가기 전 제어·서식 문자(ANSI 이스케이프 포함)를 지우고 길이를 자른다
const show = (text: string) => {
  const chars = [...clean(text)];
  return chars.length > TEXT_MAX ? `${chars.slice(0, TEXT_MAX - 1).join('')}…` : chars.join('');
};

// 색은 글을 다 만든 뒤 줄 전체에 입힌다 — 자르기·막대 너비 계산이 색 코드에 영향받지 않게.
// 상태 표시줄 stdout 은 파이프라 styleText 의 TTY 검사를 끄고, NO_COLOR 는 부르는 쪽(color)에서 따진다
const paint = (format: 'cyan' | 'green' | 'red' | 'dim', text: string, color: boolean) =>
  color ? styleText(format, text, { validateStream: false }) : text;

// 표시할 게 없으면 빈 문자열. 예) 받아쓰기 2/5 ▸ 데이터베이스 3주차 ▓▓▓▓░░░░ 42% (이모지는 쓰지 않는다)
export function renderTranscribeStatusLine(
  state: TranscribeState | null,
  queue: TranscribeQueue,
  now: number,
  alive: (pid: number) => boolean,
  color = false
): string {
  if (!state) return '';
  const { position, total } = queuePosition(state, queue);
  const count = total > 1 ? ` ${position}/${total}` : '';
  if (state.status === 'running') {
    // 강제 종료로 running 만 남은 흔적은 보이지 않는다
    if (isTranscribeStale(state, now) || !alive(state.pid)) return '';
    const parts = [`받아쓰기${count}`];
    const title = [state.course, state.title]
      .filter((t): t is string => !!t)
      .map(show)
      .join(' ');
    if (title) parts.push(` ▸ ${title}`);
    if (state.phase === 'transcribe' && state.progress !== null) {
      const filled = Math.round((state.progress / 100) * BAR_WIDTH);
      parts.push(` ${'▓'.repeat(filled)}${'░'.repeat(BAR_WIDTH - filled)} ${state.progress}%`);
    } else if (state.phase) parts.push(` ${TRANSCRIBE_PHASE_LABELS[state.phase]}`);
    return paint('cyan', parts.join(''), color);
  }
  const age = now - Date.parse(state.updatedAt);
  if (!(age >= 0 && age < STATUSLINE_HIDE_AFTER_MS)) return '';
  const failed = queue.finished.filter((f) => f.status === 'error').length;
  if (state.status === 'stopped') return paint('dim', '○ 받아쓰기 중지', color);
  if (state.status === 'error' && total <= 1)
    return paint('red', `✗ 받아쓰기 오류${state.message ? `: ${show(state.message)}` : ''}`, color);
  return paint('green', `✓ 받아쓰기 끝${total > 1 ? ` ${total}개` : ''}${failed ? ` (실패 ${failed})` : ''}`, color);
}
