import { dirname, join } from 'node:path';
import * as z from 'zod/v4';
import { PLAYER_STATE_FILE, readStateFile, stateText, writeStateFile } from '../player/state.js';

export const TRANSCRIBE_STATE_FILE = join(dirname(PLAYER_STATE_FILE), 'transcribe-state.json');
export const TRANSCRIBE_LOCK_FILE = join(dirname(PLAYER_STATE_FILE), 'transcribe.lock');
export const TRANSCRIBE_BUSY = '이미 받아쓰기가 실행 중입니다. transcribe_status 로 확인하고 끝난 뒤 다시 실행하세요.';

// 표시용 데이터만 — 영상 주소(토큰)·세션은 넣지 않는다. 혹시 메시지에 주소가 섞여도 쓸 때 지운다
export const transcribeStateSchema = z.object({
  version: z.literal(1),
  status: z.enum(['running', 'done', 'skipped', 'stopped', 'error']),
  phase: z.enum(['prepare', 'download', 'extract', 'transcribe']).nullable(),
  progress: z.number().min(0).max(100).nullable(),
  course: stateText.nullable(),
  title: stateText.nullable(),
  // 받아쓰는 프로세스 — 죽었는데 running 으로 남았는지 판단용
  pid: z.number().int().positive(),
  updatedAt: z.iso.datetime(),
  message: stateText.overwrite((s) => s.replace(/[a-z][a-z0-9+.-]*:\/\/\S+/gi, '[URL]')).nullable(),
});
export type TranscribeState = z.infer<typeof transcribeStateSchema>;

export const readTranscribeState = (file = TRANSCRIBE_STATE_FILE) => readStateFile(file, transcribeStateSchema);
export const writeTranscribeState = (state: TranscribeState, file = TRANSCRIBE_STATE_FILE) =>
  writeStateFile(file, transcribeStateSchema, state);
