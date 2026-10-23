import type { VodAttendanceData } from '@dotbugi/lms-parser';
import { describe, expect, it, vi } from 'vitest';
import { VOD_POLL_INTERVAL_MS, VOD_UNKNOWN_WARN_POLLS } from '../constants.js';
import { SessionExpiredError } from '../lms.js';
import { playVods, selectTargets, type PlayerDeps, type VodTarget } from '../player/scheduler.js';
import type { PlayerState } from '../player/state.js';
import type { TaskItem } from '../tasks/schema.js';

const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);

const L = 'https://learn.hansung.ac.kr';
const now = Date.parse('2026-10-24T12:00:00+09:00');
const vod = (title: string, deadline: string, over: Partial<TaskItem> = {}): TaskItem => ({
  type: 'vod',
  course: '자료구조',
  title,
  done: false,
  status: '미출석',
  start: '2026-10-20T00:00:00+09:00',
  deadline,
  url: `${L}/mod/vod/view.php?id=7`,
  vod: { courseId: '100', week: 3 },
  ...over,
});

describe('selectTargets', () => {
  it('기간 안 미출석 VOD 만 마감 임박 순, 동률이면 과목·주차 순', () => {
    const d1 = '2026-10-25T23:59:59+09:00';
    const items = [
      vod('나중', '2026-10-30T23:59:59+09:00'),
      vod('운영 4주', d1, { course: '운영체제', vod: { courseId: '200', week: 4 } }),
      vod('자료 5주', d1, { vod: { courseId: '100', week: 5 } }),
      vod('자료 2주', d1, { vod: { courseId: '100', week: 2 } }),
      vod('출석함', d1, { done: true }),
      vod('아직', d1, { start: '2026-10-25T00:00:00+09:00' }),
      vod('지남', '2026-10-24T11:00:00+09:00'),
      vod('외부 링크', d1, { url: 'https://evil.example/mod/vod/view.php?id=7' }),
      vod('숫자 아닌 id', d1, { url: `${L}/mod/vod/view.php?id=7%26x` }),
      vod('다른 경로', d1, { url: `${L}/mod/assign/view.php?id=7` }),
      vod('이상한 과목', d1, { vod: { courseId: '1&x=1', week: 1 } }),
      vod('과제', d1, { type: 'assign' }),
    ];
    expect(selectTargets(items, now).map((t) => t.title)).toEqual(['운영 4주', '자료 2주', '자료 5주', '나중']);
    expect(selectTargets(items, now)[1]).toEqual({
      course: '자료구조',
      title: '자료 2주',
      week: 2,
      deadline: d1,
      courseId: '100',
      cmid: '7',
    });
  });
});

const target = (title: string, cmid: string): VodTarget => ({
  course: '자료구조',
  title,
  week: 3,
  deadline: '2026-10-25T23:59:59+09:00',
  courseId: '100',
  cmid,
});
const row = (title: string, watched: string): VodAttendanceData => ({
  title,
  week: 3,
  isAttendance: watched === '20:00' ? 'o' : 'x',
  weeklyAttendance: 'x',
  requiredTime: '20:00',
  watchedTime: watched,
});

// 서버 진도 응답을 차례로 돌려주는 대역. 모든 호출을 순서대로 기록한다
function setup(responses: (VodAttendanceData[] | Error)[], sleep?: () => Promise<void>) {
  const events: string[] = [];
  const states: PlayerState[] = [];
  const controller = new AbortController();
  const deps: PlayerDeps = {
    now: () => now,
    sleep: vi.fn(sleep ?? (async () => void events.push('sleep'))),
    fetchProgress: vi.fn(async (courseId) => {
      events.push(`poll:${courseId}`);
      const next = responses.shift() ?? [];
      if (next instanceof Error) throw next;
      return next;
    }),
    open: vi.fn(async (cmid) => void events.push(`open:${cmid}`)),
    save: vi.fn(async (state) => void states.push(state)),
  };
  return { deps, events, states, controller, run: (t: VodTarget[]) => playVods(t, deps, controller.signal) };
}

describe('playVods', () => {
  it('서버가 출석을 확인해야만 다음 강의를 연다 (창은 강의마다 한 번, 이미 출석이면 열지 않음)', async () => {
    const { deps, events, states, run } = setup([
      [row('A', '05:00')],
      [row('A', '12:00')],
      [row('A', '20:00')],
      [row('B', '20:00')],
      [row('C', '00:00')],
      [row('C', '20:00')],
    ]);
    await run([target('A', '1'), target('B', '2'), target('C', '3')]);
    expect(events).toEqual([
      'poll:100',
      'open:1',
      'sleep',
      'poll:100',
      'sleep',
      'poll:100',
      'poll:100',
      'poll:100',
      'open:3',
      'sleep',
      'poll:100',
    ]);
    expect(deps.sleep).toHaveBeenCalledWith(VOD_POLL_INTERVAL_MS);
    expect(states[0]).toEqual({
      version: 1,
      status: 'playing',
      updatedAt: '2026-10-24T03:00:00.000Z',
      total: 3,
      index: 1,
      current: {
        course: '자료구조',
        title: 'A',
        week: 3,
        deadline: '2026-10-25T23:59:59+09:00',
        progress: 25,
        remainingSeconds: 900,
      },
      next: { course: '자료구조', title: 'B', week: 3, deadline: '2026-10-25T23:59:59+09:00' },
      message: null,
    });
    expect(states[1]).toMatchObject({ index: 1, current: { progress: 60, remainingSeconds: 480 } });
    expect(states[2]).toMatchObject({ index: 3, current: { title: 'C', progress: 0 }, next: null });
    expect(states.at(-1)).toMatchObject({ status: 'done', index: 0, current: null, next: null, message: null });
    // 상태 파일에는 표시용 데이터만 (cmid·과목 id·URL 없음)
    expect(JSON.stringify(states)).not.toMatch(/cmid|courseId|http/);
  });

  it('진도 행을 못 찾거나 조회가 잠깐 실패해도 넘어가지 않고 다시 확인한다 (원인도 로그에)', async () => {
    const failure = new Error('VOD 진도 조회 실패', { cause: new Error('LMS 응답 오류 HTTP 500') });
    const { events, states, run } = setup([[], failure, [row('A', '20:00')]]);
    await run([target('A', '1')]);
    expect(events).toEqual(['poll:100', 'open:1', 'sleep', 'poll:100', 'sleep', 'poll:100']);
    expect(states[0].current).toMatchObject({ progress: null, remainingSeconds: null });
    expect(states.at(-1)?.status).toBe('done');
    expect(stderr.mock.calls.join('')).toContain('VOD 진도 조회 실패: LMS 응답 오류 HTTP 500');
  });

  it(`진도를 ${VOD_UNKNOWN_WARN_POLLS}번 연속 모르면 상태에 경고를 남기고, 다시 알면 지운다`, async () => {
    const unknown = Array.from({ length: VOD_UNKNOWN_WARN_POLLS }, () => [] as VodAttendanceData[]);
    const { states, run } = setup([...unknown, [row('A', '05:00')], [row('A', '20:00')]]);
    await run([target('A', '1')]);
    const messages = states.map((s) => s.message);
    expect(messages.slice(0, VOD_UNKNOWN_WARN_POLLS - 1).every((m) => m === null)).toBe(true);
    expect(messages[VOD_UNKNOWN_WARN_POLLS - 1]).toContain('서버 진도를 한동안 확인하지 못했습니다');
    expect(messages[VOD_UNKNOWN_WARN_POLLS]).toBeNull();
  });

  it('상태 파일 쓰기가 실패해도 재생은 계속된다', async () => {
    const { deps, events, run } = setup([[row('A', '05:00')], [row('A', '20:00')]]);
    deps.save = vi.fn(async () => {
      throw new Error('EACCES');
    });
    await run([target('A', '1')]);
    expect(events).toEqual(['poll:100', 'open:1', 'sleep', 'poll:100']);
  });

  it('이미 중지됐으면 더 요청하지 않고 stopped', async () => {
    const { deps, states, controller, run } = setup([]);
    controller.abort();
    await run([target('A', '1')]);
    expect(deps.fetchProgress).not.toHaveBeenCalled();
    expect(states).toEqual([expect.objectContaining({ status: 'stopped', index: 1 })]);
  });

  it('출석 인정 기간이 끝나면 그 강의는 건너뛴다', async () => {
    const { deps, events, run } = setup([[row('A', '05:00')], [row('B', '20:00')]]);
    deps.now = () => Date.parse('2026-10-26T00:00:00+09:00');
    await run([target('A', '1'), target('B', '2')]);
    expect(events).toEqual(['poll:100', 'poll:100']);
  });

  it('세션이 만료되면 멈추고 login 안내를 상태에 남긴다', async () => {
    const { deps, states, run } = setup([[row('A', '05:00')], new SessionExpiredError()]);
    await expect(run([target('A', '1'), target('B', '2')])).rejects.toBeInstanceOf(SessionExpiredError);
    expect(deps.open).toHaveBeenCalledTimes(1);
    expect(states.at(-1)).toMatchObject({
      status: 'error',
      index: 1,
      message: expect.stringContaining('dotbugi-mcp login'),
    });
  });

  it('중지하면 다음 강의를 열지 않고 stopped 로 남긴다', async () => {
    let abort = () => {};
    const { deps, states, controller, run } = setup([[row('A', '05:00')]], async () => {
      abort();
      throw new DOMException('aborted', 'AbortError');
    });
    abort = () => controller.abort();
    await run([target('A', '1'), target('B', '2')]);
    expect(deps.open).toHaveBeenCalledTimes(1);
    expect(states.at(-1)).toMatchObject({ status: 'stopped', index: 1, current: { title: 'A', progress: 25 } });
  });

  it('볼 강의가 없으면 아무것도 열지 않고 done', async () => {
    const { deps, states, run } = setup([]);
    await run([]);
    expect(deps.open).not.toHaveBeenCalled();
    expect(states).toEqual([expect.objectContaining({ status: 'done', total: 0, index: 0 })]);
  });
});
