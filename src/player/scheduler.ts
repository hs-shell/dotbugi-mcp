import type { VodAttendanceData } from '@dotbugi/lms-parser';
import {
  LMS_NUMERIC_ID,
  LMS_ORIGIN,
  VOD_PLAYER_PATH,
  VOD_POLL_INTERVAL_MS,
  VOD_UNKNOWN_WARN_POLLS,
} from '../constants.js';
import { SessionExpiredError } from '../lms.js';
import { log } from '../log.js';
import { redact } from '../redact.js';
import type { TaskItem } from '../tasks/schema.js';
import { deadlineMs } from '../tasks/time.js';
import { progressOf, type Progress } from './progress.js';
import type { PlayerState, PlayerVod } from './state.js';

export interface VodTarget extends PlayerVod {
  courseId: string;
  cmid: string;
}

export interface PlayerDeps {
  now: () => number;
  // 중지 신호가 오면 reject 해야 한다
  sleep: (ms: number) => Promise<void>;
  fetchProgress: (courseId: string) => Promise<VodAttendanceData[]>;
  open: (cmid: string) => Promise<void>;
  save: (state: PlayerState) => Promise<void>;
}

// LMS 가 준 링크가 정확히 LMS 의 플레이어 주소일 때만 숫자 cmid 를 꺼낸다
function cmidOf(url: string): string | null {
  try {
    const u = new URL(url);
    const id = u.searchParams.get('id') ?? '';
    return u.origin === LMS_ORIGIN && u.pathname === VOD_PLAYER_PATH && LMS_NUMERIC_ID.test(id) ? id : null;
  } catch {
    return null;
  }
}

// 출석 인정 기간 안의 미출석 VOD, 마감 임박 순 (동률이면 과목·주차 순)
export function selectTargets(items: TaskItem[], now: number): VodTarget[] {
  return items
    .flatMap((t): VodTarget[] => {
      const cmid = cmidOf(t.url);
      if (t.type !== 'vod' || t.done || !t.vod || !cmid || !LMS_NUMERIC_ID.test(t.vod.courseId)) return [];
      if (!(deadlineMs(t.start) <= now && now <= deadlineMs(t.deadline))) return [];
      return [
        { course: t.course, title: t.title, week: t.vod.week, deadline: t.deadline, courseId: t.vod.courseId, cmid },
      ];
    })
    .sort(
      (a, b) =>
        deadlineMs(a.deadline) - deadlineMs(b.deadline) || a.course.localeCompare(b.course, 'ko') || a.week - b.week
    );
}

const UNKNOWN_WARNING =
  '서버 진도를 한동안 확인하지 못했습니다. 강의를 보고 있는지, LMS 진도 페이지가 바뀌지 않았는지 확인하세요.';

const display = ({ course, title, week, deadline }: PlayerVod): PlayerVod => ({ course, title, week, deadline });

// 서버가 출석(진도 100%)을 확인해야만 다음 강의로 넘어간다. 창은 강의마다 한 번만 연다
export async function playVods(targets: VodTarget[], deps: PlayerDeps, signal: AbortSignal): Promise<void> {
  let index = 0;
  let progress: Progress | null = null;
  // 상태 파일은 표시용이라 쓰기 실패로 재생을 끝내거나 원래 오류를 가리지 않는다
  const save = (status: PlayerState['status'], message: string | null = null) => {
    const current = targets[index];
    const next = targets[index + 1];
    const state: PlayerState = {
      version: 1,
      status,
      updatedAt: new Date(deps.now()).toISOString(),
      total: targets.length,
      index: current ? index + 1 : 0,
      current: current
        ? {
            ...display(current),
            progress: progress?.progress ?? null,
            remainingSeconds: progress?.remainingSeconds ?? null,
          }
        : null,
      next: next ? display(next) : null,
      message,
    };
    return deps.save(state).catch((err: unknown) => log(`상태 파일을 쓰지 못했습니다. (${describe(err)})`));
  };

  log(`볼 VOD ${targets.length}개 — 마감 임박 순으로 엽니다. 멈추려면 Ctrl+C`);
  try {
    for (; index < targets.length; index++) {
      const vod = targets[index];
      progress = null;
      let opened = false;
      let unknown = 0;
      for (;;) {
        signal.throwIfAborted();
        progress = await poll(deps, vod);
        if (progress.done) {
          log(`진도 100% 확인: ${vod.course} · ${vod.title}`);
          break;
        }
        if (deadlineMs(vod.deadline) < deps.now()) {
          log(`출석 인정 기간이 끝나 건너뜁니다: ${vod.course} · ${vod.title}`);
          break;
        }
        // 진도를 계속 모르면(행을 못 찾음·조회 실패) 마감까지 조용히 기다리지 않고 알린다
        unknown = progress.progress === null ? unknown + 1 : 0;
        const warning = unknown >= VOD_UNKNOWN_WARN_POLLS ? UNKNOWN_WARNING : null;
        if (unknown === VOD_UNKNOWN_WARN_POLLS) log(UNKNOWN_WARNING);
        await save('playing', warning);
        if (!opened) {
          await deps.open(vod.cmid);
          opened = true;
          log(`(${index + 1}/${targets.length}) ${vod.course} · ${vod.title} — 다 보면 창은 직접 닫아 주세요`);
        }
        await deps.sleep(VOD_POLL_INTERVAL_MS);
      }
    }
    progress = null;
    await save('done');
    log('볼 VOD 를 모두 마쳤습니다.');
  } catch (err) {
    if (signal.aborted) {
      await save('stopped');
      return log('중지했습니다. (열린 창은 직접 닫아 주세요)');
    }
    await save('error', redact(describe(err)));
    throw err;
  }
}

// 일시적인 조회 실패는 다음 주기에 다시 본다. 세션 만료만 멈춘다
async function poll(deps: PlayerDeps, vod: VodTarget): Promise<Progress> {
  try {
    return progressOf(await deps.fetchProgress(vod.courseId), vod);
  } catch (err) {
    if (err instanceof SessionExpiredError) throw err;
    log(`진도를 확인하지 못했습니다. 잠시 뒤 다시 확인합니다. (${describe(err)})`);
    return { done: false, progress: null, remainingSeconds: null };
  }
}

// 파서가 감싼 원인(시간 초과·HTTP 코드)까지 보여 준다. 출력은 log·redact 를 거친다
function describe(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  return err.cause instanceof Error ? `${err.message}: ${err.cause.message}` : err.message;
}
