import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { PassThrough } from 'node:stream';
import type { CourseBase } from '@dotbugi/lms-parser';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { courses, findCourse, formatList, pick, pickerReducer, type PickerState } from '../commands/courses.js';
import {
  COURSES_FILE,
  readCoursesConfig,
  selectTrackedCourses,
  writeCoursesConfig,
  type CoursesConfig,
} from '../tasks/courses.js';
import { fakeLmsFetch } from './fixtures/lms-pages.js';

const state = vi.hoisted(() => ({ home: `${process.env.TMPDIR ?? '/tmp'}/dotbugi-courses-home-${process.pid}` }));
vi.mock('node:os', async (orig) => ({ ...(await orig<typeof import('node:os')>()), homedir: () => state.home }));
vi.mock('../session.js', () => ({ getSession: async () => ({ session: 'abcdefghij0123456789' }) }));
vi.stubGlobal('fetch', vi.fn<typeof fetch>(fakeLmsFetch));
vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

const course = (courseId: string, courseTitle: string, isCommunity = false) =>
  ({ courseId, courseTitle, isCommunity }) as CourseBase;
const ALL = [course('100', '[A반] 자료구조'), course('200', '자료구조 실습'), course('300', '비교과 활동', true)];
const empty: CoursesConfig = { version: 1, courses: {} };

beforeEach(() => rm(state.home, { recursive: true, force: true }));
afterEach(() => {
  process.exitCode = undefined;
});

describe('추적 설정', () => {
  it('없으면 기본값 — 정규 켜짐, 비교과 꺼짐. 직접 정한 값이 우선', () => {
    expect(readCoursesConfig()).toEqual(empty);
    expect(selectTrackedCourses(ALL, empty).map((c) => c.courseId)).toEqual(['100', '200']);
    const config = { version: 1 as const, courses: { '100': false, '300': true } };
    expect(selectTrackedCourses(ALL, config).map((c) => c.courseId)).toEqual(['200', '300']);
  });

  it('0700 디렉터리·0600 파일로 쓰고 다시 읽는다', async () => {
    await writeCoursesConfig({ version: 1, courses: { '100': false } });
    expect(readCoursesConfig()).toEqual({ version: 1, courses: { '100': false } });
    expect((await stat(COURSES_FILE)).mode & 0o777).toBe(0o600);
    expect((await stat(dirname(COURSES_FILE))).mode & 0o777).toBe(0o700);
  });

  it('형식이 틀린 파일(숫자가 아닌 courseId·버전·값)은 기본값으로 본다', async () => {
    await mkdir(dirname(COURSES_FILE), { recursive: true });
    for (const bad of [
      { version: 1, courses: { abc: true } },
      { version: 2, courses: {} },
      { version: 1, courses: { '100': 'yes' } },
    ]) {
      await writeFile(COURSES_FILE, JSON.stringify(bad));
      expect(readCoursesConfig()).toEqual(empty);
    }
    await expect(writeCoursesConfig({ version: 1, courses: { '../x': true } })).rejects.toThrow();
  });
});

describe('--list · --on · --off', () => {
  it('목록은 켜짐/꺼짐·id·과목명, 제어문자는 지운다', () => {
    const list = formatList([...ALL, course('400', 'evil\x1b[2J\nname')], empty);
    expect(list).toBe(
      '켜짐\t100\t[A반] 자료구조\n켜짐\t200\t자료구조 실습\n꺼짐\t300\t비교과 활동 (비교과)\n켜짐\t400\tevil [2J name'
    );
  });

  it('courseId 정확히 또는 과목명 일부(대소문자 무시)로 찾고, 여러 개·없음은 오류', () => {
    expect(findCourse(ALL, '200').courseId).toBe('200');
    expect(findCourse(ALL, '비교과').courseId).toBe('300');
    expect(findCourse([course('1', 'Data Structure')], 'data').courseId).toBe('1');
    expect(() => findCourse(ALL, '자료구조')).toThrow(/여러 강좌.*\n.*100.*\n.*200/);
    expect(() => findCourse(ALL, '없는과목')).toThrow('일치하는 강좌가 없습니다');
  });

  it('--on/--off 는 LMS 강좌 목록에서 찾아 저장한다', async () => {
    await courses({ on: '비교과' });
    await courses({ off: '100' });
    expect(JSON.parse(await readFile(COURSES_FILE, 'utf8'))).toEqual({
      version: 1,
      courses: { '300': true, '100': false },
    });
  });

  it('--list 와 --on 등을 함께 쓰면 오류', async () => {
    await expect(courses({ list: true, on: 'x' })).rejects.toThrow('하나만');
  });
});

describe('대화형 선택', () => {
  const start: PickerState = { cursor: 0, on: [true, true, false] };
  const keys = (...names: string[]) => names.reduce((s, name) => pickerReducer(s, { name }), start);

  it('↑↓/k·j 로 이동(끝에서 멈춤), Space 로 토글, Enter 저장', () => {
    expect(keys('up').cursor).toBe(0);
    expect(keys('down', 'j', 'down').cursor).toBe(2);
    expect(keys('down', 'k').cursor).toBe(0);
    expect(keys('down', 'down', 'space', 'up', 'space').on).toEqual([true, false, true]);
    expect(keys('return').done).toBe('save');
  });

  it('q·Esc 는 취소, Ctrl+C 는 중단', () => {
    expect(keys('q').done).toBe('cancel');
    expect(keys('escape').done).toBe('cancel');
    expect(pickerReducer(start, { name: 'c', ctrl: true }).done).toBe('interrupt');
  });

  const fakeTty = () => {
    const input = Object.assign(new PassThrough(), { isTTY: true, setRawMode: vi.fn() });
    const output = new PassThrough();
    return { input: input as unknown as Parameters<typeof pick>[2], setRawMode: input.setRawMode, output, raw: input };
  };

  it('취소하면 null, 터미널 raw 모드를 되돌린다', async () => {
    const { input, setRawMode, output, raw } = fakeTty();
    const result = pick(ALL, [true, true, false], input, output);
    raw.write(' q');
    await expect(result).resolves.toBeNull();
    expect(setRawMode.mock.calls).toEqual([[true], [false]]);
    expect(raw.listenerCount('keypress')).toBe(0);
  });

  it('Ctrl+C 도 모드를 되돌리고 종료 코드 130', async () => {
    const { input, setRawMode, output, raw } = fakeTty();
    const result = pick(ALL, [true, true, false], input, output);
    raw.write('\x03');
    await expect(result).resolves.toBeNull();
    expect(setRawMode).toHaveBeenLastCalledWith(false);
    expect(process.exitCode).toBe(130);
  });

  it('Space·Enter 로 바꾼 값을 돌려준다', async () => {
    const { input, output, raw } = fakeTty();
    const result = pick(ALL, [true, true, false], input, output);
    raw.write(' \r');
    await expect(result).resolves.toEqual([false, true, false]);
  });
});
