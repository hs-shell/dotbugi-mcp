import { EventEmitter } from 'node:events';
import { rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { spawn } from 'node:child_process';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { adoptLock } from '../player/lock.js';
import { idleState, PLAYER_LOCK_FILE, PLAYER_STATE_FILE, readPlayerState, writePlayerState } from '../player/state.js';
import { PLAYER_STATE_STALE_MS } from '../constants.js';
import { startPlayer, stopPlayer } from '../tools/play-vods.js';

// 상태·잠금 경로는 import 시점에 homedir 로 정해진다 — 그 전에 테스트 전용 홈을 정한다
const state = vi.hoisted(() => ({ home: `${process.env.TMPDIR ?? '/tmp'}/dotbugi-play-home-${process.pid}` }));
vi.mock('node:os', async (orig) => ({ ...(await orig<typeof import('node:os')>()), homedir: () => state.home }));

afterEach(async () => {
  await rm(PLAYER_LOCK_FILE, { force: true });
  await rm(PLAYER_STATE_FILE, { force: true });
});
afterAll(() => rm(state.home, { recursive: true, force: true }));

describe('startPlayer', () => {
  // 작업 프로세스 pid 로는 살아 있는 이 테스트 프로세스를 쓴다
  const deps = (over: Partial<Parameters<typeof startPlayer>[0]> = {}) => {
    const spawnImpl = vi.fn(() => {
      const c = Object.assign(new EventEmitter(), { unref: vi.fn(), pid: process.pid });
      setImmediate(() => c.emit('spawn'));
      return c;
    });
    return {
      spawn: spawnImpl as unknown as typeof spawn,
      getSession: vi.fn(async () => ({ session: 's', savedAt: '', method: 'extension' as const })),
      ...over,
    };
  };

  it('세션이 없으면 띄우지 않고 login 안내 오류', async () => {
    const d = deps({ getSession: vi.fn(() => Promise.reject(new Error('저장된 LMS 세션이 없습니다. login 도구를'))) });
    await expect(startPlayer(d)).rejects.toThrow('login');
    expect(d.spawn).not.toHaveBeenCalled();
    await expect(stat(PLAYER_LOCK_FILE)).rejects.toThrow();
  });

  it('한 번만 인자 배열로 띄우고 잠금을 넘기며, 재생 중이면 다시 띄우지 않는다', async () => {
    expect(PLAYER_LOCK_FILE.startsWith(join(state.home))).toBe(true);
    const d = deps();
    await expect(startPlayer(d)).resolves.toBe(true);
    await expect(startPlayer(d)).resolves.toBe(false);
    expect(d.spawn).toHaveBeenCalledTimes(1);
    expect(d.spawn).toHaveBeenCalledWith(process.execPath, [expect.stringMatching(/index\.js$/), 'play', '--worker'], {
      detached: true,
      stdio: 'ignore',
    });
    expect(readPlayerState(PLAYER_STATE_FILE)).toMatchObject({ status: 'playing', pid: process.pid });
    const release = await adoptLock(PLAYER_LOCK_FILE, 100);
    await release();
  });
});

describe('stopPlayer', () => {
  const OTHER = 424242;
  const deps = (alive = true) => ({
    // 신호를 받은 작업 프로세스가 잠금을 푸는 것을 흉내 낸다
    kill: vi.fn(() => void rm(PLAYER_LOCK_FILE, { force: true })),
    isAlive: vi.fn(() => alive),
    timeoutMs: 1000,
  });
  const lockWith = async (pid: number | string, statePid: number | undefined) => {
    await writePlayerState(PLAYER_STATE_FILE, { ...idleState('playing', 1), pid: statePid });
    await writeFile(PLAYER_LOCK_FILE, String(pid));
  };

  it('잠금이 없거나 죽은 pid 면 재생 중이 아니라고 답한다', async () => {
    const d = deps(false);
    await expect(stopPlayer(d)).resolves.toContain('재생 중인 VOD 가 없습니다');
    await lockWith(OTHER, OTHER);
    await expect(stopPlayer(d)).resolves.toContain('없습니다');
    expect(d.kill).not.toHaveBeenCalled();
  });

  it('살아 있고 상태 파일 pid 와 맞으면 SIGTERM 을 보내고 잠금 해제를 기다린다', async () => {
    const d = deps();
    await lockWith(OTHER, OTHER);
    await expect(stopPlayer(d)).resolves.toContain('중지했습니다');
    expect(d.kill).toHaveBeenCalledExactlyOnceWith(OTHER, 'SIGTERM');
  });

  it.each([
    ['내 pid', process.pid, process.pid],
    ['상태 pid 불일치(재사용 의심)', OTHER, OTHER + 1],
    ['상태에 pid 없음', OTHER, undefined],
    ['0', '0', OTHER],
    ['음수', '-1', OTHER],
    ['숫자 아님', 'abc', OTHER],
  ])('%s 면 신호를 보내지 않는다', async (_, lockPid, statePid) => {
    const d = deps();
    await lockWith(lockPid, statePid);
    await stopPlayer(d);
    expect(d.kill).not.toHaveBeenCalled();
  });

  it('갱신이 끊긴(강제 종료 흔적) 상태면 pid 가 맞아도 신호를 보내지 않는다', async () => {
    const d = deps();
    await lockWith(OTHER, OTHER);
    const stale = new Date(Date.now() - PLAYER_STATE_STALE_MS - 1000).toISOString();
    await writePlayerState(PLAYER_STATE_FILE, { ...idleState('playing', 1), pid: OTHER, updatedAt: stale });
    await expect(stopPlayer(d)).resolves.toContain('확인하지 못해');
    expect(d.kill).not.toHaveBeenCalled();
  });

  it('신호를 받고 잠금을 못 푼 채 끝나도(시작 직후) 중지로 본다', async () => {
    let alive = true;
    const d = { kill: vi.fn(() => void (alive = false)), isAlive: vi.fn(() => alive), timeoutMs: 1000 };
    await lockWith(OTHER, OTHER);
    await expect(stopPlayer(d)).resolves.toContain('중지했습니다');
  });

  it('상태가 playing 이 아니면 신호를 보내지 않는다', async () => {
    const d = deps();
    await lockWith(OTHER, OTHER);
    await writePlayerState(PLAYER_STATE_FILE, idleState('stopped', OTHER));
    await expect(stopPlayer(d)).resolves.toContain('확인하지 못해');
    expect(d.kill).not.toHaveBeenCalled();
  });
});
