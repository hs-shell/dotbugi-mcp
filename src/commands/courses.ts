import { emitKeypressEvents, type Key } from 'node:readline';
import type { CourseBase } from '@dotbugi/lms-parser';
import { LMS_NUMERIC_ID, SIGNAL_EXIT_CODES } from '../constants.js';
import { createFetchHtml } from '../lms-html.js';
import { log } from '../log.js';
import { getSession } from '../session.js';
import { listAllCourses } from '../tasks/collect.js';
import { isTracked, readCoursesConfig, writeCoursesConfig, type CoursesConfig } from '../tasks/courses.js';
import { clean } from '../tasks/text.js';

export interface CoursesOptions {
  list?: boolean;
  on?: string;
  off?: string;
}

// LMS 텍스트를 터미널에 그대로 쓰면 제어문자로 화면을 조작할 수 있다 — clean 으로 한 줄 평문만
const label = (c: CourseBase) => `${clean(c.courseTitle)}${c.isCommunity ? ' (비교과)' : ''}`;

export const formatList = (all: CourseBase[], config: CoursesConfig) =>
  all.map((c) => `${isTracked(c, config) ? '켜짐' : '꺼짐'}\t${c.courseId}\t${label(c)}`).join('\n');

// courseId 정확히 일치 또는 과목명 일부(대소문자 무시). 0개·여러 개면 오류
export function findCourse(all: CourseBase[], query: string): CourseBase {
  const byId = all.find((c) => c.courseId === query);
  if (byId) return byId;
  const q = query.toLowerCase();
  const matches = all.filter((c) => clean(c.courseTitle).toLowerCase().includes(q));
  if (matches.length === 1) return matches[0];
  if (matches.length === 0) throw new Error(`일치하는 강좌가 없습니다: ${clean(query)}`);
  throw new Error(
    `여러 강좌가 일치합니다. courseId 나 더 긴 이름으로 지정하세요:\n${matches.map((c) => `  ${c.courseId}\t${label(c)}`).join('\n')}`
  );
}

export interface PickerState {
  cursor: number;
  on: boolean[];
  // save: Enter, cancel: q·Esc, interrupt: Ctrl+C
  done?: 'save' | 'cancel' | 'interrupt';
}

// 키 입력 → 다음 상태 (TTY 없이 테스트할 수 있게 순수 함수로)
export function pickerReducer(state: PickerState, key: Key): PickerState {
  const last = state.on.length - 1;
  if (key.ctrl && key.name === 'c') return { ...state, done: 'interrupt' };
  switch (key.name) {
    case 'up':
    case 'k':
      return { ...state, cursor: Math.max(0, state.cursor - 1) };
    case 'down':
    case 'j':
      return { ...state, cursor: Math.min(last, state.cursor + 1) };
    case 'space':
      return { ...state, on: state.on.map((v, i) => (i === state.cursor ? !v : v)) };
    case 'return':
    case 'enter':
      return { ...state, done: 'save' };
    case 'q':
    case 'escape':
      return { ...state, done: 'cancel' };
    default:
      return state;
  }
}

const HELP = '↑↓ 이동 · Space 켜기/끄기 · Enter 저장 · q/Esc 취소';

export function renderPicker(all: CourseBase[], state: PickerState): string[] {
  return [HELP, ...all.map((c, i) => `${i === state.cursor ? '>' : ' '} [${state.on[i] ? 'x' : ' '}] ${label(c)}`)];
}

type RawInput = NodeJS.ReadStream & { setRawMode(mode: boolean): unknown };

// 대화형 선택. 저장하면 켜짐 배열, 취소하면 null. 어떤 경로로 끝나도 터미널 모드를 되돌린다
export async function pick(
  all: CourseBase[],
  initial: boolean[],
  input: RawInput = process.stdin as RawInput,
  output: NodeJS.WritableStream = process.stderr
): Promise<boolean[] | null> {
  let state: PickerState = { cursor: 0, on: initial };
  let drawn = 0;
  const draw = () => {
    const lines = renderPicker(all, state);
    // 이전 화면 줄 수만큼 올라가 지우고 다시 그린다
    output.write(`${drawn ? `\x1b[${drawn}A` : ''}\x1b[J${lines.join('\n')}\n`);
    drawn = lines.length;
  };
  emitKeypressEvents(input);
  input.setRawMode(true);
  input.resume();
  let onKey: ((s: string, key: Key) => void) | undefined;
  let onSignal: ((signal: keyof typeof SIGNAL_EXIT_CODES) => void) | undefined;
  try {
    draw();
    return await new Promise<boolean[] | null>((resolve, reject) => {
      onKey = (_s, key) => {
        try {
          state = pickerReducer(state, key);
          if (state.done === 'interrupt') process.exitCode = SIGNAL_EXIT_CODES.SIGINT;
          if (state.done) resolve(state.done === 'save' ? state.on : null);
          else draw();
        } catch (err) {
          reject(err);
        }
      };
      // raw 모드에선 Ctrl+C 가 키로 오지만, 터미널 종료(SIGHUP·SIGTERM)에도 모드를 되돌리고 끝낸다
      onSignal = (signal) => {
        process.exitCode = SIGNAL_EXIT_CODES[signal];
        resolve(null);
      };
      input.on('keypress', onKey);
      for (const s of Object.keys(SIGNAL_EXIT_CODES) as (keyof typeof SIGNAL_EXIT_CODES)[]) process.once(s, onSignal);
    });
  } finally {
    if (onKey) input.off('keypress', onKey);
    if (onSignal) for (const s of Object.keys(SIGNAL_EXIT_CODES)) process.off(s, onSignal);
    input.setRawMode(false);
    input.pause();
  }
}

export async function courses(opts: CoursesOptions): Promise<void> {
  if ([opts.list, opts.on !== undefined, opts.off !== undefined].filter(Boolean).length > 1)
    throw new Error('--list · --on · --off 는 하나만 쓸 수 있습니다.');
  const { session } = await getSession();
  // 설정 파일 키는 숫자 courseId 만 받는다
  const all = (await listAllCourses(createFetchHtml(session))).filter((c) => LMS_NUMERIC_ID.test(c.courseId));
  if (all.length === 0) return log('LMS 메인에 강좌가 없습니다.');
  const config = readCoursesConfig();

  const query = opts.on ?? opts.off;
  if (query !== undefined) {
    const course = findCourse(all, query);
    await writeCoursesConfig({ ...config, courses: { ...config.courses, [course.courseId]: opts.on !== undefined } });
    return log(`${opts.on !== undefined ? '켰습니다' : '껐습니다'}: ${label(course)}`);
  }
  if (opts.list || !process.stdin.isTTY || !process.stderr.isTTY) {
    process.stdout.write(`${formatList(all, config)}\n`);
    if (!opts.list) log('터미널에서 실행하면 목록에서 바로 켜고 끌 수 있습니다 (또는 --on/--off <과목명|courseId>).');
    return;
  }

  const result = await pick(
    all,
    all.map((c) => isTracked(c, config))
  );
  if (!result) return log('저장하지 않았습니다.');
  // 지금 목록에 없는 강좌(지난 학기 등)의 값은 그대로 둔다
  const next = { ...config.courses, ...Object.fromEntries(all.map((c, i) => [c.courseId, result[i]])) };
  await writeCoursesConfig({ version: 1, courses: next });
  log(`저장했습니다 (켜짐 ${result.filter(Boolean).length}/${all.length}).`);
}
