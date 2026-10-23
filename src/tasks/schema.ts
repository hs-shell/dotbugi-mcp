import * as z from 'zod/v4';
import { COURSE_FILTER_MAX_LENGTH } from '../constants.js';

export const TASK_TYPES = ['vod', 'assign', 'quiz'] as const;
export type TaskType = (typeof TASK_TYPES)[number];

export const listTasksInput = z.object({
  type: z
    .enum(TASK_TYPES)
    .optional()
    .describe('종류만 보기: vod(강의 영상) / assign(과제) / quiz(퀴즈). 생략하면 전부'),
  incompleteOnly: z.boolean().default(true).describe('미완료(미출석·미제출)만. 기본 true'),
  withinDays: z.number().positive().optional().describe('마감이 N일 이내인 것만 (마감 정보가 없는 항목은 제외)'),
  course: z.string().min(1).max(COURSE_FILTER_MAX_LENGTH).optional().describe('과목명 일부 (대소문자 무시)'),
  refresh: z.boolean().default(false).describe('1시간 캐시를 무시하고 LMS 에서 다시 가져오기'),
});
export type ListTasksInput = z.infer<typeof listTasksInput>;

const task = z.object({
  type: z.enum(TASK_TYPES),
  course: z.string(),
  title: z.string(),
  done: z.boolean(),
  status: z.string().describe('예: 출석 / 미출석 (진도 40%) / 제출 / 미제출 / 응시 / 미응시'),
  start: z.string().nullable().describe('VOD 출석 인정 시작 (과제·퀴즈는 null)'),
  deadline: z.string().nullable().describe('마감(VOD는 출석 인정 종료). 오프셋 포함 ISO, 해석 불가 시 LMS 원문'),
  remaining: z.string().describe('남은 시간 (예: 2일 3시간)'),
  url: z.string().describe('LMS 주소 (LMS 출처가 아니면 빈 문자열)'),
});
export type Task = z.infer<typeof task>;
// 캐시에 담는 형태 — 남은 시간은 조회 시점에 계산한다. vod 는 VOD 스케줄러 내부용(list_tasks 로는 내보내지 않음)
export type TaskItem = Omit<Task, 'remaining'> & { vod?: { courseId: string; week: number } };

export const listTasksOutput = z.object({
  fetchedAt: z.string().describe('LMS 에서 가져온 시각 (ISO)'),
  tasks: z.array(task).describe('마감 임박 순'),
  warnings: z.array(z.string()).describe('일부 과목·항목을 가져오지 못한 경우의 안내 (없으면 빈 배열)'),
});
export type ListTasksOutput = z.infer<typeof listTasksOutput>;
