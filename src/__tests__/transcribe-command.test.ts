import { rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';

// 상태·잠금 경로는 import 시점에 homedir 로 정해진다 — 그 전에 테스트 전용 홈을 정한다
const state = vi.hoisted(() => ({
  home: `${process.env.TMPDIR ?? process.env.TEMP ?? '/tmp'}/dotbugi-transcribe-cmd-${process.pid}`,
}));
vi.mock('node:os', async (orig) => ({ ...(await orig<typeof import('node:os')>()), homedir: () => state.home }));
const SESSION = 'abcdefghij0123456789';
vi.mock('../session.js', () => ({ getSession: async () => ({ session: SESSION, savedAt: '', method: 'extension' }) }));
const transcribeVod = vi.fn();
vi.mock('../transcribe/pipeline.js', () => ({ transcribeVod: (...a: unknown[]) => transcribeVod(...a) }));
import { LOGIN_PAGE } from './fixtures/lms-pages.js';
const logs: string[] = [];
vi.mock('../log.js', () => ({ log: (m: string) => logs.push(m) }));

const { transcribe } = await import('../commands/transcribe.js');
const { readTranscribeState, TRANSCRIBE_LOCK_FILE } = await import('../transcribe/state.js');

const signals = () => ['SIGINT', 'SIGTERM', 'SIGHUP'].reduce((n, s) => n + process.listenerCount(s), 0);
const before = signals();
afterEach(async () => {
  transcribeVod.mockReset();
  logs.length = 0;
  // 어느 경로로 끝나도 잠금·신호 처리기를 남기지 않는다
  await expect(stat(TRANSCRIBE_LOCK_FILE)).rejects.toThrow();
  expect(signals()).toBe(before);
});
afterAll(() => rm(state.home, { recursive: true, force: true }));

describe('transcribe 명령', () => {
  it.each(['', 'abc', '-1', '1.5', '12345678901', '../1'])('숫자가 아닌 cmid 는 잠그기 전에 거절: %j', async (arg) => {
    await expect(transcribe(arg)).rejects.toThrow('숫자여야');
    expect(transcribeVod).not.toHaveBeenCalled();
  });

  it('성공하면 done·100%·경로를 남기고 진행은 10% 단위로만 출력한다', async () => {
    const path = join(state.home, 'out.md');
    transcribeVod.mockImplementation(async (cmid: number, deps: { report(p: string, n: number | null): void }) => {
      expect(cmid).toBe(42);
      deps.report('download', null);
      for (const p of [1, 5, 9, 10, 15]) deps.report('transcribe', p);
      return { status: 'done', path };
    });
    await transcribe('42');
    expect(readTranscribeState()).toMatchObject({
      status: 'done',
      phase: null,
      progress: 100,
      path,
      cmid: 42,
      message: '녹취를 저장했습니다.',
    });
    expect(logs).toEqual(['[영상 받는 중]', '[받아쓰는 중] 1%', '[받아쓰는 중] 10%', `녹취를 저장했습니다. ${path}`]);
  });

  it('이미 녹취가 있으면 skipped, 진행률 없음', async () => {
    transcribeVod.mockResolvedValue({ status: 'skipped', path: '/x.md' });
    await transcribe('42');
    expect(readTranscribeState()).toMatchObject({ status: 'skipped', progress: null, path: '/x.md' });
  });

  it('작업 프로세스(worker)는 출력하지 않는다', async () => {
    const { acquireLock } = await import('../player/lock.js');
    const { TRANSCRIBE_BUSY } = await import('../transcribe/state.js');
    // 도구가 잠금을 잡아 넘겨준 상황
    await acquireLock(TRANSCRIBE_LOCK_FILE, TRANSCRIBE_BUSY);
    transcribeVod.mockImplementation(async (_: number, deps: { report(p: string, n: null): void }) => {
      deps.report('download', null);
      return { status: 'done', path: '/x.md' };
    });
    await transcribe('42', true);
    expect(logs).toEqual([]);
    expect(readTranscribeState()?.status).toBe('done');
  });

  it('재생 화면(viewer.php)이 200 로그인 화면이면 세션 만료로 멈춘다', async () => {
    const fetchMock = vi.fn(async () => new Response(LOGIN_PAGE));
    vi.stubGlobal('fetch', fetchMock);
    try {
      transcribeVod.mockImplementation(async (_: number, deps: { viewerHtml(id: number): Promise<string> }) =>
        deps.viewerHtml(42)
      );
      await expect(transcribe('42')).rejects.toThrow('세션이 만료');
      expect(readTranscribeState()).toMatchObject({ status: 'error' });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('실패하면 error 를 남기고, 오류·상태에 세션 값이 없다', async () => {
    transcribeVod.mockRejectedValue(new Error(`HTTP 500 for MoodleSession=${SESSION}`));
    const err = (await transcribe('42').catch((e: unknown) => e)) as Error;
    expect(err.message).toContain('HTTP 500');
    expect(err.message).not.toContain(SESSION);
    const s = readTranscribeState();
    expect(s).toMatchObject({ status: 'error' });
    expect(JSON.stringify(s)).not.toContain(SESSION);
    expect(process.exitCode).toBeUndefined();
  });
});
