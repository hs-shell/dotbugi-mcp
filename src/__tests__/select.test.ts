import { describe, expect, it } from 'vitest';
import type { TaskItem } from '../tasks/schema.js';
import { selectTasks } from '../tasks/select.js';

const now = Date.parse('2026-10-24T12:00:00+09:00');
const item = (title: string, deadline: string | null, over: Partial<TaskItem> = {}): TaskItem => ({
  type: 'assign',
  course: '자료구조',
  title,
  done: false,
  status: '미제출',
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
  it('남은 시간을 붙인다', () => {
    expect(selectTasks(items, { incompleteOnly: true }, now)[0].remaining).toBe('6시간 0분');
  });
});
