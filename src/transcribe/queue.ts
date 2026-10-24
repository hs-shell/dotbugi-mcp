import { dirname, join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import * as z from 'zod/v4';
import { asrLanguageSchema } from '../asr/runtime.js';
import { TRANSCRIBE_QUEUE_MAX } from '../constants.js';
import { acquireLock } from '../player/lock.js';
import { readStateFile, stateText, writeStateFile } from '../player/state.js';
import { TRANSCRIBE_STATE_FILE, type TranscribeState } from './state.js';

export const TRANSCRIBE_QUEUE_FILE = join(dirname(TRANSCRIBE_STATE_FILE), 'transcribe-queue.json');
const QUEUE_LOCK_FILE = join(dirname(TRANSCRIBE_STATE_FILE), 'transcribe-queue.lock');
const QUEUE_LOCK_WAIT_MS = 5000;

// 대기 중인 강의와 이번 묶음에서 끝난 강의. 지금 받아쓰는 강의는 상태 파일(transcribe-state.json)에 있다
export const transcribeQueueSchema = z.object({
  version: z.literal(1),
  pending: z
    .array(z.object({ cmid: z.number().int().positive(), language: asrLanguageSchema }))
    .max(TRANSCRIBE_QUEUE_MAX),
  finished: z
    .array(
      z.object({
        cmid: z.number().int().positive(),
        status: z.enum(['done', 'skipped', 'error']),
        title: stateText.nullable(),
      })
    )
    .max(TRANSCRIBE_QUEUE_MAX),
});
export type TranscribeQueue = z.infer<typeof transcribeQueueSchema>;

export const EMPTY_QUEUE: TranscribeQueue = { version: 1, pending: [], finished: [] };
export const readTranscribeQueue = (file = TRANSCRIBE_QUEUE_FILE) =>
  readStateFile(file, transcribeQueueSchema) ?? EMPTY_QUEUE;
export const writeTranscribeQueue = (queue: TranscribeQueue, file = TRANSCRIBE_QUEUE_FILE) =>
  // 오래 돌면 끝난 기록이 상한을 넘는다 — 최근 것만 남긴다
  writeStateFile(file, transcribeQueueSchema, { ...queue, finished: queue.finished.slice(-TRANSCRIBE_QUEUE_MAX) });

// 대기열을 고치는 쪽(도구의 추가, 작업 프로세스의 꺼내기·끝내기)은 이 잠금 안에서만 — 작업 프로세스가 "비었다"고 보고
// 끝나는 순간 도구가 뒤에 붙여 아무도 받아쓰지 않는 항목이 생기지 않게. 잠깐만 잡으므로 바쁘면 조금 기다린다
export async function withQueueLock<T>(fn: () => Promise<T>): Promise<T> {
  for (const end = Date.now() + QUEUE_LOCK_WAIT_MS; ; await sleep(50)) {
    let release: () => Promise<void>;
    try {
      release = await acquireLock(QUEUE_LOCK_FILE, '받아쓰기 대기열을 잠그지 못했습니다. 잠시 뒤 다시 시도하세요.');
    } catch (err) {
      if (Date.now() > end) throw err;
      continue;
    }
    try {
      return await fn();
    } finally {
      await release();
    }
  }
}

// 상태 표시용 "몇 번째 / 전체". 실행 중이면 끝난 것 + 지금 것 + 대기, 끝났으면 끝난 것만
export function queuePosition(state: TranscribeState | null, queue: TranscribeQueue) {
  const running = state?.status === 'running' ? 1 : 0;
  const total = queue.finished.length + running + queue.pending.length;
  return { position: Math.min(queue.finished.length + running, total), total };
}
