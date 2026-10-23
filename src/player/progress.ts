import { fetchVodProgress, getVodProgressPageLink, type VodAttendanceData } from '@dotbugi/lms-parser';
import { createFetchHtml } from '../lms-html.js';
import { SessionExpiredError } from '../lms.js';
import { isAttended, toSeconds } from '../tasks/collect.js';
import { clean } from '../tasks/text.js';

export interface Progress {
  done: boolean;
  progress: number | null;
  remainingSeconds: number | null;
}

// 과목 진도 페이지(user_progress.php) 한 장. 전역 동시 요청 제한을 거치는 createFetchHtml 을 쓴다
export function createProgressFetcher(session: string): (courseId: string) => Promise<VodAttendanceData[]> {
  const fetchHtml = createFetchHtml(session);
  return (courseId) =>
    fetchVodProgress(fetchHtml, getVodProgressPageLink(courseId)).catch((err: unknown) => {
      // 파서가 원래 오류를 cause 로 감싼다 — 세션 만료는 그대로 올려야 스케줄러가 멈춘다
      if (err instanceof Error && err.cause instanceof SessionExpiredError) throw err.cause;
      throw err;
    });
}

// 서버 진도 행에서 이 강의(제목+주차)를 찾아 진도를 계산한다. 못 찾으면 모름(미완료)
export function progressOf(rows: VodAttendanceData[], vod: { title: string; week: number }): Progress {
  const row = rows.find((r) => r.week === vod.week && clean(r.title) === vod.title);
  if (!row) return { done: false, progress: null, remainingSeconds: null };
  const required = toSeconds(row.requiredTime ?? '');
  const watched = toSeconds(row.watchedTime ?? '');
  const known = Number.isFinite(watched) && Number.isFinite(required) && required > 0;
  return {
    // user_progress.php 의 출석 판정 = 총 학습시간 ≥ 출석인정 요구시간 (진도 100%)
    done: isAttended(row.isAttendance),
    progress: known ? Math.min(100, Math.floor((watched / required) * 100)) : null,
    remainingSeconds: known ? Math.max(0, required - watched) : null,
  };
}
