import { lstatSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { CourseBase } from '@dotbugi/lms-parser';
import * as z from 'zod/v4';
import { LMS_NUMERIC_ID } from '../constants.js';
import { log } from '../log.js';
import { readStateFile, writeStateFile } from '../player/state.js';
import { clean } from './text.js';

// 확장의 강좌 토글과는 별개인 MCP 전용 설정 (확장 storage 는 읽을 수 없다). courseId 별 켜기/끄기만 담는다
export const COURSES_FILE = join(homedir(), '.config', 'dotbugi-mcp', 'courses.json');

const coursesConfigSchema = z.object({
  version: z.literal(1),
  courses: z.record(z.string().regex(LMS_NUMERIC_ID), z.boolean()),
});
export type CoursesConfig = z.infer<typeof coursesConfigSchema>;

// 없거나 깨진 파일은 기본값(모두 미지정)으로 본다. 깨진 파일은 알리고, strict(쓰기 전)면 덮어쓰지 않게 오류
export function readCoursesConfig(file = COURSES_FILE, strict = false): CoursesConfig {
  const config = readStateFile(file, coursesConfigSchema);
  if (config) return config;
  if (lstatSync(file, { throwIfNoEntry: false })) {
    // 기본값으로 덮어쓰면 사용자가 고른 값이 조용히 사라진다
    const message = `강좌 설정 파일을 읽지 못했습니다 (형식 오류 등): ${file} — 지우면 기본값으로 초기화됩니다.`;
    if (strict) throw new Error(`${message} 덮어쓰지 않았습니다.`);
    log(`${message} 지금은 기본값으로 처리합니다.`);
  }
  return { version: 1, courses: {} };
}

export const writeCoursesConfig = (config: CoursesConfig, file = COURSES_FILE) =>
  writeStateFile(file, coursesConfigSchema, config);

// 직접 정한 값이 우선, 없으면 정규 강좌 켜짐·비교과 꺼짐 (새 학기에 처음 보는 강좌도 기본값)
export const isTracked = (course: CourseBase, config: CoursesConfig) =>
  config.courses[course.courseId] ?? !course.isCommunity;

// 모든 소비자(list_tasks·sync·transcribe)가 같은 기준으로 강좌를 고르게 하는 단일 지점
export const selectTrackedCourses = (all: CourseBase[], config: CoursesConfig) =>
  all.filter((c) => isTracked(c, config));

// courseId 정확히 일치 또는 과목명 일부(대소문자 무시). CLI --on/--off 와 set_course_tracking 이 같은 규칙을 쓴다
export function matchCourses(all: CourseBase[], query: string): CourseBase[] {
  const byId = all.find((c) => c.courseId === query);
  if (byId) return [byId];
  const q = query.toLowerCase();
  return all.filter((c) => clean(c.courseTitle).toLowerCase().includes(q));
}

// 같은 프로세스 안의 저장을 차례로 — MCP 클라이언트가 두 강좌 변경을 동시에 보내도 하나를 잃지 않게 (읽기도 차례 안에서)
let saving: Promise<void> = Promise.resolve();

// 한 강좌만 바꿔 저장. 깨진 설정 파일은 덮어쓰지 않게 strict 로 읽는다
export function saveCourseTracking(courseId: string, tracked: boolean, file = COURSES_FILE): Promise<void> {
  const run = saving.then(() => {
    const config = readCoursesConfig(file, true);
    return writeCoursesConfig({ ...config, courses: { ...config.courses, [courseId]: tracked } }, file);
  });
  saving = run.catch(() => {});
  return run;
}
