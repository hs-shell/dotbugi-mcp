import { stat } from 'node:fs/promises';
import { afterAll, afterEach, expect, it, vi } from 'vitest';
import { rm } from 'node:fs/promises';

// 상태·잠금 경로는 import 시점에 homedir 로 정해진다 — 그 전에 테스트 전용 홈을 정한다
const state = vi.hoisted(() => ({ home: `${process.env.TMPDIR ?? '/tmp'}/dotbugi-transcribe-stop-${process.pid}` }));
vi.mock('node:os', async (orig) => ({ ...(await orig<typeof import('node:os')>()), homedir: () => state.home }));
vi.mock('../session.js', () => ({ getSession: async () => ({ session: 's', savedAt: '', method: 'extension' }) }));
// 파이프라인은 중지 신호가 올 때까지 기다렸다 실패한다 (실제 파이프라인의 정리는 transcribe.test 에서 본다)
vi.mock('../transcribe/pipeline.js', () => ({
  transcribeVod: (_: number, deps: { signal: AbortSignal; report(p: string, n: null): void }) =>
    new Promise((_, reject) => {
      deps.report('download', null);
      deps.signal.addEventListener('abort', () => reject(new Error('aborted')));
    }),
}));

const { transcribe } = await import('../commands/transcribe.js');
const { readTranscribeState, TRANSCRIBE_HEARTBEAT_MS, TRANSCRIBE_LOCK_FILE } = await import('../transcribe/state.js');

afterEach(() => {
  vi.useRealTimers();
  process.exitCode = undefined;
});
afterAll(() => rm(state.home, { recursive: true, force: true }));

it('SIGTERM 을 받으면 파이프라인을 멈추고 stopped 를 쓴 뒤 잠금을 푼다', async () => {
  const done = transcribe('42');
  await vi.waitFor(() => expect(readTranscribeState()?.phase).toBe('download'));
  process.emit('SIGTERM', 'SIGTERM');
  await done;
  expect(readTranscribeState()).toMatchObject({ status: 'stopped', pid: process.pid });
  expect(process.exitCode).toBe(143);
  await expect(stat(TRANSCRIBE_LOCK_FILE)).rejects.toThrow();
});

it('진행이 멈춰 있어도 박동으로 updatedAt 을 갱신하고, 끝나면 박동을 멈춘다', async () => {
  // 파일 쓰기·waitFor 는 실제 타이머로 두고 박동(setInterval)과 시각만 가짜로
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
  const done = transcribe('42');
  await vi.waitFor(() => expect(readTranscribeState()?.phase).toBe('download'));
  const before = Date.parse(readTranscribeState()!.updatedAt);
  vi.advanceTimersByTime(TRANSCRIBE_HEARTBEAT_MS);
  await vi.waitFor(() =>
    expect(Date.parse(readTranscribeState()!.updatedAt)).toBeGreaterThanOrEqual(before + TRANSCRIBE_HEARTBEAT_MS)
  );
  expect(readTranscribeState()?.status).toBe('running');

  process.emit('SIGTERM', 'SIGTERM');
  await done;
  expect(vi.getTimerCount()).toBe(0);
  const after = readTranscribeState();
  vi.advanceTimersByTime(3 * TRANSCRIBE_HEARTBEAT_MS);
  await new Promise((r) => setImmediate(r));
  expect(readTranscribeState()).toEqual(after);
});
