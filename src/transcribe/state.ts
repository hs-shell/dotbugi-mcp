import { dirname, join } from 'node:path';
import * as z from 'zod/v4';
import { asrLanguageSchema } from '../asr/runtime.js';
import { PLAYER_STATE_FILE, readStateFile, stateText, writeStateFile } from '../player/state.js';
import { stripUrls } from '../redact.js';

const CACHE_DIR = dirname(PLAYER_STATE_FILE);
export const TRANSCRIBE_STATE_FILE = join(CACHE_DIR, 'transcribe-state.json');
export const TRANSCRIBE_LOCK_FILE = join(CACHE_DIR, 'transcribe.lock');
// 임시 영상 파일 자리. 고정 경로라 강제 종료로 남은 것도 다음 실행이 지운다 (tmpfs /tmp 면 RAM 을 쓴다)
export const TRANSCRIBE_TMP_DIR = join(CACHE_DIR, 'transcribe-tmp');
// 작업 프로세스는 단계 진행이 없어도(ASR 이 한참 계산만 할 때) 이 간격으로 상태를 다시 쓴다 — 살아 있다는 표시
export const TRANSCRIBE_HEARTBEAT_MS = 60_000;
// 이보다 오래 갱신이 없으면 강제 종료된 작업의 흔적으로 본다 (박동 3번을 놓친 셈)
export const TRANSCRIBE_STATE_STALE_MS = 3 * TRANSCRIBE_HEARTBEAT_MS;
export const TRANSCRIBE_BUSY = '이미 STT 변환이 실행 중입니다. transcribe_status 로 확인하고 끝난 뒤 다시 실행하세요.';

// 단계 이름 (터미널 진행 출력·상태 표시줄)
export const TRANSCRIBE_PHASE_LABELS = {
  prepare: '준비',
  download: '영상 받는 중',
  extract: '소리 추출',
  transcribe: 'STT 변환 중',
} as const;

// 표시용 데이터만 — 영상 주소(토큰)·세션은 넣지 않는다. 혹시 메시지에 주소가 섞여도 쓸 때 지운다
export const transcribeStateSchema = z.object({
  version: z.literal(1),
  status: z.enum(['running', 'done', 'skipped', 'stopped', 'error']),
  cmid: z.number().int().positive(),
  phase: z.enum(['prepare', 'download', 'extract', 'transcribe']).nullable(),
  progress: z.number().min(0).max(100).nullable(),
  course: stateText.nullable(),
  title: stateText.nullable(),
  // 저장한(또는 이미 있던) 녹취 파일. 경로는 자르지 않는다
  path: z.string().max(4096).nullable(),
  // 받아쓰는 프로세스 — 죽었는데 running 으로 남았는지 판단용
  pid: z.number().int().positive(),
  updatedAt: z.iso.datetime(),
  // 받아쓰기 언어 설정 (표시용). 이 필드가 생기기 전 상태 파일엔 없다
  language: asrLanguageSchema.optional(),
  message: stateText.overwrite(stripUrls).nullable(),
});
export type TranscribeState = z.infer<typeof transcribeStateSchema>;

export const readTranscribeState = (file = TRANSCRIBE_STATE_FILE) => readStateFile(file, transcribeStateSchema);
export const writeTranscribeState = (state: TranscribeState, file = TRANSCRIBE_STATE_FILE) =>
  writeStateFile(file, transcribeStateSchema, state);

// 실행 중인데 갱신이 끊김. 미래 시각(시계가 뒤로 감)도 믿을 수 없어 끊긴 것으로 본다
export function isTranscribeStale(state: TranscribeState, now: number): boolean {
  const age = now - Date.parse(state.updatedAt);
  return state.status === 'running' && (age > TRANSCRIBE_STATE_STALE_MS || age < 0);
}
