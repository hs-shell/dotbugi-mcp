import { describe, expect, it } from 'vitest';
import type { TaskItem } from '../tasks/schema.js';
import { cmidOfUrl, selectTasks } from '../tasks/select.js';

const now = Date.parse('2026-10-24T12:00:00+09:00');
const item = (title: string, deadline: string | null, over: Partial<TaskItem> = {}): TaskItem => ({
  type: 'assign',
  course: '자료구조',
  title,
  done: false,
  status: '미제출',
  start: null,
  deadline,
  url: 'https://learn.hansung.ac.kr/x',
  ...over,
});

const items = [
  item('없음', null),
  item('나중', '2026-10-30T00:00:00+09:00'),
  item('완료', '2026-10-25T00:00:00+09:00', { done: true, status: '제출' }),
  item('곧', '2026-10-24T18:00:00+09:00', { type: 'quiz', course: '운영체제' }),
  item('지남', '2026-10-24T11:00:00+09:00'),
];
const titles = (input: Parameters<typeof selectTasks>[1]) => selectTasks(items, input, now).map((t) => t.title);

describe('selectTasks', () => {
  it('미완료만, 마감 임박 순, 마감 없음은 뒤, 지난 마감 제외', () => {
    expect(titles({ incompleteOnly: true })).toEqual(['곧', '나중', '없음']);
  });
  it('완료 포함', () => {
    expect(titles({ incompleteOnly: false })).toEqual(['곧', '완료', '나중', '없음']);
  });
  it('N일 이내 (마감 없음 제외)', () => {
    expect(titles({ incompleteOnly: false, withinDays: 1 })).toEqual(['곧', '완료']);
  });
  it('종류·과목(부분, 대소문자 무시) 필터', () => {
    expect(titles({ incompleteOnly: true, type: 'quiz' })).toEqual(['곧']);
    expect(titles({ incompleteOnly: true, course: '운영' })).toEqual(['곧']);
  });
  it('VOD 는 조회 시점에 출석 인정 기간 안인 것만', () => {
    const vod = (title: string, start: string | null, deadline: string | null) =>
      item(title, deadline, { type: 'vod', start });
    const vods = [
      vod('진행 중', '2026-10-20T00:00:00+09:00', '2026-10-27T23:59:59+09:00'),
      vod('아직', '2026-10-28T00:00:00+09:00', '2026-11-03T23:59:59+09:00'),
      vod('기간 모름', null, null),
    ];
    expect(selectTasks(vods, { incompleteOnly: true }, now).map((t) => t.title)).toEqual(['진행 중']);
  });
  it('남은 시간을 붙인다', () => {
    expect(selectTasks(items, { incompleteOnly: true }, now)[0].remaining).toBe('6시간 0분');
  });
  it('includePast: 지난 미완료(VOD 포함)를 overdue 로 맨 앞에, 지난 완료는 여전히 제외', () => {
    const past = [
      ...items,
      item('지난 완료', '2026-10-24T10:00:00+09:00', { done: true }),
      item('놓친 강의', '2026-10-23T23:59:59+09:00', { type: 'vod', start: '2026-10-16T00:00:00+09:00' }),
      item('아직 강의', '2026-11-03T23:59:59+09:00', { type: 'vod', start: '2026-10-28T00:00:00+09:00' }),
    ];
    const tasks = selectTasks(past, { incompleteOnly: false, includePast: true }, now);
    expect(tasks.map((t) => t.title)).toEqual(['놓친 강의', '지남', '곧', '완료', '나중', '없음']);
    expect(tasks.map((t) => t.overdue)).toEqual([true, true, false, false, false, false]);
    expect(tasks[0].remaining).toBe('지남');
    expect(selectTasks(past, { incompleteOnly: true, includePast: false }, now).some((t) => t.overdue)).toBe(false);
  });
  it('cmid 는 LMS 출처 주소의 숫자 id 만', () => {
    expect(cmidOfUrl('https://learn.hansung.ac.kr/mod/assign/view.php?id=123')).toBe(123);
    expect(cmidOfUrl('https://learn.hansung.ac.kr/mod/vod/view.php?id=1&x=2')).toBe(1);
    expect(cmidOfUrl('https://evil.example/mod/assign/view.php?id=123')).toBeNull();
    expect(cmidOfUrl('https://learn.hansung.ac.kr/mod/assign/view.php?id=12a')).toBeNull();
    expect(cmidOfUrl('https://learn.hansung.ac.kr/x')).toBeNull();
    expect(cmidOfUrl('')).toBeNull();
    expect(
      selectTasks(
        [item('a', null, { url: 'https://learn.hansung.ac.kr/mod/quiz/view.php?id=7' })],
        { incompleteOnly: true },
        now
      )[0].cmid
    ).toBe(7);
  });
});
