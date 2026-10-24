import type { BandLine } from '../types';

// src/transcribe/status-line.ts 와 같은 규칙의 한 줄. 설치된 플러그인엔 이 폴더만 복사되고 mod 모듈엔 Node 가 없어
// src 를 가져올 수 없다 — 그래서 작은 순수 함수로 따로 둔다 (바꿀 땐 둘 다)
const BAR_WIDTH = 8;
const TEXT_MAX = 30;
// src/transcribe/state.ts 의 TRANSCRIBE_STATE_STALE_MS. pid 확인을 못 하므로 갱신이 끊긴 것만으로 강제 종료를 가린다
export const STALE_MS = 3 * 60_000;
// src/constants.ts 의 STATUSLINE_HIDE_AFTER_MS — 끝난 줄을 상태 표시줄과 같이 1분만 보여 준다
export const HIDE_AFTER_MS = 60_000;
const PHASE_LABELS: Record<string, string> = {
  prepare: '준비',
  download: '영상 받는 중',
  extract: '소리 추출',
  transcribe: 'STT 변환 중',
};

// 상태 파일은 다른 프로세스가 쓴 디스크 데이터 — 모양을 직접 확인한다. 글(과목·제목·메시지)은 LMS 출처라
// 제어·서식 문자를 지우고 자른다 (src/tasks/text.ts 의 clean 과 같은 규칙)
const show = (value: unknown) => {
  if (typeof value !== 'string') return '';
  const chars = [...value.replace(/[\s\p{Cc}\p{Cf}]+/gu, ' ').trim()];
  return chars.length > TEXT_MAX ? `${chars.slice(0, TEXT_MAX - 1).join('')}…` : chars.join('');
};
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const field = (value: unknown, key: string): unknown =>
  value && typeof value === 'object' ? (value as Record<string, unknown>)[key] : undefined;

// 보여 줄 게 없으면 null. 예) STT 2/5 ▸ 데이터베이스 3주차 ▓▓▓░░░░░ 42%
export function formatBand(state: unknown, queue: unknown, now: number): BandLine | null {
  const status = field(state, 'status');
  const updatedAt = field(state, 'updatedAt');
  if (typeof status !== 'string' || typeof updatedAt !== 'string') return null;
  const age = now - Date.parse(updatedAt);
  // 미래 시각(시계가 뒤로 감)·읽을 수 없는 시각은 믿지 않는다
  if (!(age >= 0)) return null;
  const finished = list(field(queue, 'finished'));
  const running = status === 'running' ? 1 : 0;
  const total = finished.length + running + list(field(queue, 'pending')).length;
  if (running) {
    if (age > STALE_MS) return null;
    const position = Math.min(finished.length + running, total);
    const parts = [`STT${total > 1 ? ` ${position}/${total}` : ''}`];
    const title = [show(field(state, 'course')), show(field(state, 'title'))].filter(Boolean).join(' ');
    if (title) parts.push(` ▸ ${title}`);
    const phase = field(state, 'phase');
    const progress = field(state, 'progress');
    if (phase === 'transcribe' && typeof progress === 'number' && progress >= 0 && progress <= 100) {
      const filled = Math.round((progress / 100) * BAR_WIDTH);
      parts.push(` ${'▓'.repeat(filled)}${'░'.repeat(BAR_WIDTH - filled)} ${Math.round(progress)}%`);
    } else if (typeof phase === 'string' && PHASE_LABELS[phase]) parts.push(` ${PHASE_LABELS[phase]}`);
    return { text: parts.join(''), tone: 'running' };
  }
  if (age >= HIDE_AFTER_MS) return null;
  if (status === 'stopped') return { text: '○ STT 중지', tone: 'stopped' };
  if (status === 'error' && total <= 1) {
    const message = show(field(state, 'message'));
    return { text: `✗ STT 오류${message ? `: ${message}` : ''}`, tone: 'error' };
  }
  if (status !== 'done' && status !== 'skipped' && status !== 'error') return null;
  const failed = finished.filter((f) => field(f, 'status') === 'error').length;
  return { text: `✓ STT${total > 1 ? ` ${total}개` : ''} 완료${failed ? ` (실패 ${failed})` : ''}`, tone: 'done' };
}
