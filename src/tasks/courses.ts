import { homedir } from 'node:os';
import { join } from 'node:path';
import type { CourseBase } from '@dotbugi/lms-parser';
import * as z from 'zod/v4';
import { LMS_NUMERIC_ID } from '../constants.js';
import { readStateFile, writeStateFile } from '../player/state.js';

// 확장의 강좌 토글과는 별개인 MCP 전용 설정 (확장 storage 는 읽을 수 없다). courseId 별 켜기/끄기만 담는다
export const COURSES_FILE = join(homedir(), '.config', 'dotbugi-mcp', 'courses.json');

const coursesConfigSchema = z.object({
  version: z.literal(1),
  courses: z.record(z.string().regex(LMS_NUMERIC_ID), z.boolean()),
});
export type CoursesConfig = z.infer<typeof coursesConfigSchema>;

// 없거나 깨진 파일은 기본값(모두 미지정)으로 본다
export const readCoursesConfig = (file = COURSES_FILE): CoursesConfig =>
  readStateFile(file, coursesConfigSchema) ?? { version: 1, courses: {} };

export const writeCoursesConfig = (config: CoursesConfig, file = COURSES_FILE) =>
  writeStateFile(file, coursesConfigSchema, config);

// 직접 정한 값이 우선, 없으면 정규 강좌 켜짐·비교과 꺼짐 (새 학기에 처음 보는 강좌도 기본값)
export const isTracked = (course: CourseBase, config: CoursesConfig) =>
  config.courses[course.courseId] ?? !course.isCommunity;

// 모든 소비자(list_tasks·vod_status·play·sync·transcribe)가 같은 기준으로 강좌를 고르게 하는 단일 지점
export const selectTrackedCourses = (all: CourseBase[], config: CoursesConfig) =>
  all.filter((c) => isTracked(c, config));
