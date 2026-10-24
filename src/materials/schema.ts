import * as z from 'zod/v4';
import { COURSE_FILTER_MAX_LENGTH } from '../constants.js';

export const syncMaterialsInput = z.object({
  course: z
    .string()
    .min(1)
    .max(COURSE_FILTER_MAX_LENGTH)
    .optional()
    .describe('과목명 일부 (대소문자 무시). 생략하면 수강 과목 전부'),
});

export const syncMaterialsOutput = z.object({
  root: z
    .string()
    .describe(
      '저장 위치 (기본 ~/Downloads/dotbugi-mcp, get_storage_dir·set_storage_dir). 자료는 그 아래 <YYYY-N학기>/<과목>/'
    ),
  files: z
    .array(
      z.object({
        course: z.string(),
        week: z.string().describe('주차 폴더 이름 (예: 3주차, 주차 없는 섹션은 섹션명)'),
        path: z.string().describe('로컬 파일 경로'),
        status: z
          .enum(['added', 'updated', 'unchanged'])
          .describe('added 새로 받음 / updated 새 버전 / unchanged 변경 없음'),
      })
    )
    .describe('LMS 에 있는 강의자료 전부의 로컬 경로'),
  removed: z
    .array(z.object({ course: z.string(), path: z.string(), locallyModified: z.boolean() }))
    .describe('LMS 에서 사라진 파일. 로컬 파일은 지우지 않았다 — 삭제는 delete_materials(사용자 승인)'),
  warnings: z.array(z.string()).describe('받지 못했거나 덮어쓰지 않고 따로 저장한 파일 등 안내 (없으면 빈 배열)'),
  more: z.boolean().describe('true 면 한 번 호출 상한에 걸려 남은 자료가 있다 — 다시 호출하면 이어서 받는다'),
});
export type SyncMaterialsOutput = z.infer<typeof syncMaterialsOutput>;
