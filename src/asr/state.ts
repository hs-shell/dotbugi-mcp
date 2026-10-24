import { dirname, join } from 'node:path';
import * as z from 'zod/v4';
import { PLAYER_STATE_FILE, readStateFile, stateText, writeStateFile } from '../player/state.js';
import { stripUrls } from '../redact.js';

const CACHE_DIR = dirname(PLAYER_STATE_FILE);
export const ASR_INSTALL_STATE_FILE = join(CACHE_DIR, 'asr-install-state.json');
export const ASR_INSTALL_LOCK_FILE = join(CACHE_DIR, 'asr-install.lock');
export const ASR_INSTALL_BUSY = '이미 ASR 설치가 실행 중입니다. 진행은 asr_status 로 확인하세요.';

// 표시용 진행 정보만 — 받는 주소·자격 증명은 넣지 않는다. 혹시 메시지에 주소가 섞여도 쓸 때 지운다
export const asrInstallStateSchema = z.object({
  version: z.literal(1),
  status: z.enum(['running', 'done', 'error']),
  runtime: z.enum(['cpu', 'gpu']),
  model: z.enum(['0.6b', '1.7b']),
  phase: z.enum(['ffmpeg', 'qwen_asr', 'venv', 'model']).nullable(),
  // 지금 받는 파일 (바이트). total 0 = 크기를 모름
  file: z.object({ label: stateText, done: z.number().nonnegative(), total: z.number().nonnegative() }).nullable(),
  // 설치하는 프로세스 — 죽었는데 running 으로 남았는지 판단용
  pid: z.number().int().positive(),
  updatedAt: z.iso.datetime(),
  message: stateText.overwrite(stripUrls).nullable(),
});
export type AsrInstallState = z.infer<typeof asrInstallStateSchema>;

export const readAsrInstallState = (file = ASR_INSTALL_STATE_FILE) => readStateFile(file, asrInstallStateSchema);
export const writeAsrInstallState = (state: AsrInstallState, file = ASR_INSTALL_STATE_FILE) =>
  writeStateFile(file, asrInstallStateSchema, state);
