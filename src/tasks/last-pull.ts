import { homedir } from 'node:os';
import { join } from 'node:path';
import * as z from 'zod/v4';
import { PULL_STALE_MS } from '../constants.js';
import { readStateFile, writeStateFile } from '../player/state.js';

// 마지막으로 강의자료를 끝까지 받은 시각. 할 일을 보여 주기 전에 pull 이 필요한지 판단한다
// 경로는 부를 때 계산한다 — 모듈을 읽는 시점의 홈으로 고정되지 않게
export const lastPullFile = () => join(homedir(), '.cache', 'dotbugi-mcp', 'last-pull.json');
const lastPullSchema = z.object({ at: z.number().int().nonnegative() });

export const recordPull = (now = Date.now(), file = lastPullFile()) =>
  writeStateFile(file, lastPullSchema, { at: now });

// 기록이 없거나(처음) PULL_STALE_MS 가 지났으면 stale. 미래 시각(시계 변경)도 stale 로 본다
export function pullState(now = Date.now(), file = lastPullFile()): { lastPullAt: string | null; pullStale: boolean } {
  const at = readStateFile(file, lastPullSchema)?.at;
  if (at === undefined) return { lastPullAt: null, pullStale: true };
  const age = now - at;
  return { lastPullAt: new Date(at).toISOString(), pullStale: age < 0 || age >= PULL_STALE_MS };
}
