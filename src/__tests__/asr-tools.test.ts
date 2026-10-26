import { EventEmitter } from 'node:events';
import type { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MODELS, QWEN_ASR_BINARY, UNPINNED } from '../asr/pins.js';
import { asrPaths, modelFilePath } from '../asr/runtime.js';
import {
  ASR_INSTALL_LOCK_FILE,
  ASR_INSTALL_STATE_FILE,
  readAsrInstallState,
  writeAsrInstallState,
} from '../asr/state.js';
import { asr, statusText } from '../commands/asr.js';
import { adoptLock } from '../player/lock.js';
import { asrStatus, startInstall } from '../tools/asr.js';

// 상태·잠금 경로는 import 시점에 homedir 로 정해진다 — 그 전에 테스트 전용 홈을 정한다
const home = vi.hoisted(() => ({ dir: `${process.env.TMPDIR ?? '/tmp'}/dotbugi-asr-tools-home-${process.pid}` }));
vi.mock('node:os', async (orig) => ({ ...(await orig<typeof import('node:os')>()), homedir: () => home.dir }));

let root: string;
beforeEach(async () => void (root = await mkdtemp(join(tmpdir(), 'asr-tools-'))));
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
  await rm(ASR_INSTALL_STATE_FILE, { force: true });
  await rm(ASR_INSTALL_LOCK_FILE, { force: true });
});
afterAll(() => rm(home.dir, { recursive: true, force: true }));

const deps = (over: Partial<Parameters<typeof startInstall>[1]> = {}) => {
  const spawnImpl = vi.fn(() => {
    const c = Object.assign(new EventEmitter(), { unref: vi.fn(), pid: process.pid });
    setImmediate(() => c.emit('spawn'));
    return c;
  });
  return { spawn: spawnImpl as unknown as typeof spawn, check: vi.fn(() => 'linux-x64' as const), ...over };
};

// 파일은 있지만 내용이 비어 해시가 틀린(손상된) CPU 설치
async function fakeInstall(dir: string): Promise<void> {
  const paths = asrPaths(dir);
  await mkdir(join(paths.models, '0.6b'), { recursive: true });
  await mkdir(paths.bin);
  await writeFile(paths.config, JSON.stringify({ runtime: 'cpu', model: '0.6b' }));
  for (const p of [
    paths.ffmpeg,
    paths.qwenAsr,
    ...Object.keys(MODELS['0.6b'].files).map((f) => modelFilePath(dir, '0.6b', f)),
  ])
    await writeFile(p, '');
}

const supported =
  (process.platform === 'linux' && process.arch === 'x64') ||
  (process.platform === 'darwin' && process.arch === 'arm64');
const platform = process.platform === 'darwin' ? 'macos-arm64' : 'linux-x64';

describe('asr_install', () => {
  it('미지원 플랫폼·잘못된 인자는 띄우지 않고 오류', async () => {
    const d = deps({
      check: vi.fn(() => {
        throw new Error('로컬 ASR 은 Linux(x64)·WSL·macOS(Apple Silicon) 만 지원합니다.');
      }),
    });
    await expect(startInstall({ gpu: false }, d)).rejects.toThrow('만 지원합니다');
    await expect(startInstall({ gpu: false, model: '1.7b' }, deps())).rejects.toThrow('--gpu');
    expect(d.spawn).not.toHaveBeenCalled();
    await expect(stat(ASR_INSTALL_LOCK_FILE)).rejects.toThrow();
  });

  it.skipIf(!supported)('qwen_asr 고정값이 없으면 띄우지 않고 오류', async () => {
    const pin = QWEN_ASR_BINARY[platform];
    const saved = pin.sha256;
    pin.sha256 = UNPINNED;
    const d = deps({ check: (await import('../asr/install.js')).checkInstallable });
    try {
      await expect(startInstall({ gpu: false }, d)).rejects.toThrow('고정되지 않아');
    } finally {
      pin.sha256 = saved;
    }
    expect(d.spawn).not.toHaveBeenCalled();
  });

  it('이미 설치돼 있어도(손상 포함) 띄운다 — 해시 검증은 작업 프로세스가 한다', async () => {
    await fakeInstall(root);
    const d = deps();
    expect(await startInstall({ gpu: false }, d)).toContain('시작했습니다');
    expect(d.spawn).toHaveBeenCalledTimes(1);
  });

  it('동시에 불러도 하나만 띄우고, 잠금을 작업 프로세스 pid 로 넘긴다', async () => {
    expect(ASR_INSTALL_LOCK_FILE.startsWith(join(home.dir))).toBe(true);
    const d = deps();
    const results = await Promise.all([
      startInstall({ gpu: true, model: '1.7b' }, d),
      startInstall({ gpu: true, model: '1.7b' }, d),
    ]);
    expect(results.filter((r) => r.includes('시작했습니다'))).toHaveLength(1);
    expect(results.filter((r) => r.includes('이미 ASR 설치가 실행 중'))).toHaveLength(1);
    expect(d.spawn).toHaveBeenCalledTimes(1);
    expect(d.spawn).toHaveBeenCalledWith(
      process.execPath,
      [expect.stringMatching(/index\.js$/), 'asr', 'install', '--worker', '--gpu', '--model', '1.7b'],
      { detached: true, stdio: 'ignore' }
    );
    expect(readAsrInstallState()).toMatchObject({ status: 'running', runtime: 'gpu', model: '1.7b', pid: process.pid });
    // 작업 프로세스가 잠금을 이어받고, 끝나면 푼다
    const release = await adoptLock(ASR_INSTALL_LOCK_FILE, 100);
    await release();
    await expect(stat(ASR_INSTALL_LOCK_FILE)).rejects.toThrow();
  });

  it('CPU 는 --gpu·--model 없이 띄운다', async () => {
    const d = deps();
    await startInstall({ gpu: false }, d);
    expect(d.spawn).toHaveBeenCalledWith(
      process.execPath,
      [expect.stringMatching(/index\.js$/), 'asr', 'install', '--worker'],
      expect.anything()
    );
  });
});

describe('asr_status', () => {
  it('설치 상태와 설치 작업 진행을 합쳐 보여주고, 죽은 작업은 stale', async () => {
    expect((await asrStatus(join(root, 'none'))).job).toBeNull();
    await writeAsrInstallState({
      version: 1,
      status: 'running',
      runtime: 'cpu',
      model: '0.6b',
      phase: 'model',
      file: { label: '모델 0.6b model.safetensors', done: 500e6, total: 1876e6 },
      // 없는 pid
      pid: 2 ** 22 + 1,
      updatedAt: new Date().toISOString(),
      message: null,
    });
    const { text, job } = await asrStatus(join(root, 'none'));
    expect(text).toContain('설치된 ASR 런타임이 없습니다');
    expect(text).toContain('[stale] cpu · 0.6b');
    expect(text).toContain('3/3 모델');
    expect(text).toContain('500/1876MB');
    expect(job).toMatchObject({ stale: true, phase: 'model' });
  });

  it.skipIf(!supported)('해시는 verify 일 때만, 설치 중엔 건너뛴다', async () => {
    await fakeInstall(root);
    expect((await asrStatus(root)).text).toContain('있음 (해시 검증 생략)');
    expect((await asrStatus(root, true)).text).toContain('해시 불일치');
    await writeAsrInstallState({
      version: 1,
      status: 'running',
      runtime: 'cpu',
      model: '0.6b',
      phase: 'model',
      file: null,
      pid: process.pid,
      updatedAt: new Date().toISOString(),
      message: null,
    });
    const { text } = await asrStatus(root, true);
    expect(text).not.toContain('해시 불일치');
    expect(text).toContain('해시 검증은 건너뛰었습니다');
  });

  it('상태 파일 메시지의 주소(토큰)는 지우고 쓴다', async () => {
    await writeAsrInstallState({
      version: 1,
      status: 'error',
      runtime: 'cpu',
      model: '0.6b',
      phase: 'ffmpeg',
      file: null,
      pid: process.pid,
      updatedAt: new Date().toISOString(),
      message: '실패: https://example.com/x?token=SECRET123',
    });
    const raw = await readFile(ASR_INSTALL_STATE_FILE, 'utf8');
    expect(raw).not.toContain('SECRET123');
    expect((await asrStatus(root)).text).not.toContain('SECRET123');
  });
});

describe.skipIf(!supported)('asr install (CLI·작업 프로세스)', () => {
  it('설치가 실패하면 상태 파일에 error 를 남기고 잠금을 푼다', async () => {
    const pin = QWEN_ASR_BINARY[platform];
    const saved = pin.sha256;
    pin.sha256 = UNPINNED;
    try {
      await expect(asr(['install'], {}, join(root, 'asr'))).rejects.toThrow('고정되지 않아');
    } finally {
      pin.sha256 = saved;
    }
    expect(readAsrInstallState()).toMatchObject({
      status: 'error',
      runtime: 'cpu',
      message: expect.stringContaining('고정'),
    });
    await expect(stat(ASR_INSTALL_LOCK_FILE)).rejects.toThrow();
  });

  it('설치 중이면 asr remove 를 거부한다', async () => {
    await fakeInstall(root);
    await writeFile(ASR_INSTALL_LOCK_FILE, String(process.pid));
    await expect(asr(['remove'], { yes: true }, root)).rejects.toThrow('이미 ASR 설치가 실행 중');
    expect((await stat(root)).isDirectory()).toBe(true);
  });

  it('--worker 는 install 에서만', async () => {
    await expect(asr(['status'], { worker: true }, root)).rejects.toThrow('사용법');
  });
});

describe('asr status (CLI)', () => {
  const real = { platform: process.platform, arch: process.arch };
  const setPlatform = (p: NodeJS.Platform, a: NodeJS.Architecture) => {
    Object.defineProperty(process, 'platform', { value: p, configurable: true });
    Object.defineProperty(process, 'arch', { value: a, configurable: true });
  };
  afterEach(() => setPlatform(real.platform, real.arch));

  it('미지원 플랫폼이면 바이너리는 검증할 수 없다고만 알리고, 깨진 설정·GPU venv·합계를 보여 준다', async () => {
    await fakeInstall(root);
    await writeFile(asrPaths(root).config, '{broken');
    await mkdir(join(asrPaths(root).venv, 'bin'), { recursive: true });
    await writeFile(join(asrPaths(root).venv, 'bin', 'python'), 'x'.repeat(2_000_000));
    setPlatform('win32', 'x64');
    const text = await statusText(root);
    expect(text).toContain(`위치: ${root}`);
    expect(text).not.toContain('설정: cpu · 0.6b');
    expect(text).toContain('- ffmpeg: 0MB 미지원 플랫폼(win32-x64) — 검증 불가');
    expect(text).toContain('- qwen_asr: 0MB 미지원 플랫폼(win32-x64) — 검증 불가');
    // 모델 파일은 플랫폼과 무관하게 고정값으로 검증한다
    expect(text).toMatch(/- 모델 0\.6b: 0MB .*해시 불일치/);
    expect(text).toContain('- GPU venv: 2MB');
    expect(text).toContain('합계: 2MB');
  });

  it('설정 파일이 없으면 설치 미완료, 모델 파일이 빠졌으면 없음', async () => {
    await fakeInstall(root);
    await rm(asrPaths(root).config);
    await rm(modelFilePath(root, '0.6b', 'model.safetensors'));
    const text = await statusText(root);
    expect(text).toContain('설정: 설치 미완료');
    expect(text).toContain('model.safetensors: 없음');
  });
});

describe('asr 명령 인자', () => {
  it('하위 명령이 없거나 모르는 것, 남는 인자, 엉뚱한 옵션 조합은 사용법으로 거부', async () => {
    for (const [args, opts] of [
      [[], {}],
      [['update'], {}],
      [['status', 'x'], {}],
      [['status'], { gpu: true }],
      [['remove'], { model: '1.7b' }],
      [['install'], { yes: true }],
    ] as const)
      await expect(asr([...args], opts, root)).rejects.toThrow('사용법');
  });

  it('remove 는 설치가 없으면 그렇게 알리고, 터미널이 아니면 --yes 없이 지우지 않는다', async () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const tty = process.stdin.isTTY;
    try {
      await asr(['remove'], {}, join(root, 'none'));
      expect(stderr).toHaveBeenCalledWith(expect.stringContaining('설치된 ASR 런타임이 없습니다'));
      await fakeInstall(root);
      Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });
      await expect(asr(['remove'], {}, root)).rejects.toThrow('--yes');
      expect((await stat(root)).isDirectory()).toBe(true);
    } finally {
      Object.defineProperty(process.stdin, 'isTTY', { value: tty, configurable: true });
      stderr.mockRestore();
    }
  });
});
