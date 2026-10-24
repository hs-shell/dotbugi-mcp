import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TASKS_CACHE_TTL_MS } from '../constants.js';
import type { CollectResult } from '../tasks/collect.js';
import type { CoursesConfig } from '../tasks/courses.js';
import type { TaskItem } from '../tasks/schema.js';

const collectTasks = vi.fn<(session: string, cachedQuizzes?: unknown, config?: unknown) => Promise<CollectResult>>();
vi.mock('../tasks/collect.js', () => ({
  collectTasks: (...args: [string, unknown, unknown]) => collectTasks(...args),
}));
// 실제 ~/.config 대신 테스트가 정하는 추적 설정
let config: CoursesConfig = { version: 1, courses: {} };
vi.mock('../tasks/courses.js', () => ({ readCoursesConfig: () => config }));

const quiz: TaskItem = {
  type: 'quiz',
  course: '자료구조',
  title: '퀴즈1',
  done: true,
  status: '응시',
  start: null,
  deadline: null,
  url: 'https://learn.hansung.ac.kr/mod/quiz/view.php?id=9',
};
const ok = (items: TaskItem[] = [quiz]): CollectResult => ({ items, failures: 0 });

// 모듈 상태(캐시)를 테스트마다 새로 시작한다
let getTaskItems: typeof import('../tasks/cache.js').getTaskItems;
beforeEach(async () => {
  vi.resetModules();
  collectTasks.mockReset().mockResolvedValue(ok());
  config = { version: 1, courses: {} };
  ({ getTaskItems } = await import('../tasks/cache.js'));
});

describe('getTaskItems', () => {
  it('세션이 바뀌면 캐시를 쓰지 않고, 이전 계정의 퀴즈 상태도 넘기지 않는다', async () => {
    await getTaskItems('A', false);
    await getTaskItems('A', false);
    expect(collectTasks).toHaveBeenCalledTimes(1);
    await getTaskItems('B', false);
    expect(collectTasks).toHaveBeenCalledTimes(2);
    expect(collectTasks).toHaveBeenLastCalledWith('B', undefined, config);
  });

  it('캐시가 만료돼 다시 가져올 때는 직전 성공 결과의 퀴즈 제출 상태를 cachedQuizzes 로 넘긴다', async () => {
    await getTaskItems('A', false, 0);
    expect(collectTasks).toHaveBeenLastCalledWith('A', undefined, config);
    await getTaskItems('A', false, TASKS_CACHE_TTL_MS);
    expect(collectTasks).toHaveBeenLastCalledWith('A', [{ url: quiz.url, isSubmit: true }], config);
  });

  it('명시적 refresh 면 퀴즈 제출 상태 캐시도 쓰지 않고 다시 조회한다', async () => {
    await getTaskItems('A', false);
    await getTaskItems('A', true);
    expect(collectTasks).toHaveBeenCalledTimes(2);
    expect(collectTasks).toHaveBeenLastCalledWith('A', undefined, config);
  });

  it('실패하면 캐시에서 빼고 다음 호출이 다시 가져온다', async () => {
    collectTasks.mockRejectedValueOnce(new Error('boom'));
    await expect(getTaskItems('A', false)).rejects.toThrow('boom');
    await expect(getTaskItems('A', false)).resolves.toMatchObject({ failures: 0 });
    expect(collectTasks).toHaveBeenCalledTimes(2);
  });

  it('일부가 빠진 결과는 돌려주되 캐시하지 않고, 퀴즈 상태로도 쓰지 않는다', async () => {
    collectTasks.mockResolvedValueOnce({ items: [quiz], failures: 2 });
    await expect(getTaskItems('A', false)).resolves.toMatchObject({ failures: 2 });
    await getTaskItems('A', false);
    expect(collectTasks).toHaveBeenCalledTimes(2);
    expect(collectTasks).toHaveBeenLastCalledWith('A', undefined, config);
  });

  it('진행 중에 refresh 하면 새로 가져오고, 먼저 시작한 요청의 실패가 새 캐시를 지우지 않는다', async () => {
    let failFirst!: (err: Error) => void;
    collectTasks.mockReturnValueOnce(new Promise((_, reject) => (failFirst = reject)));
    const first = getTaskItems('A', false);
    const second = getTaskItems('A', true);
    failFirst(new Error('old'));
    await expect(first).rejects.toThrow('old');
    await second;
    await getTaskItems('A', false);
    expect(collectTasks).toHaveBeenCalledTimes(2);
  });

  it('강좌 추적 설정이 바뀌면 캐시를 쓰지 않고 새 설정으로 가져온다', async () => {
    await getTaskItems('A', false);
    await getTaskItems('A', false);
    expect(collectTasks).toHaveBeenCalledTimes(1);
    config = { version: 1, courses: { '100': false } };
    await getTaskItems('A', false);
    expect(collectTasks).toHaveBeenCalledTimes(2);
    expect(collectTasks).toHaveBeenLastCalledWith('A', expect.anything(), config);
  });

  it('진행 중인 요청은 동시 호출이 공유한다', async () => {
    await Promise.all([getTaskItems('A', false), getTaskItems('A', false)]);
    expect(collectTasks).toHaveBeenCalledTimes(1);
  });
});
