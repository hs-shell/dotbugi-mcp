import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { checkInstallable, detectPlatform, estimateBytes, installAsr } from '../asr/install.js';
import { FFMPEG, MODELS, modelFileUrl, QWEN_ASR_BINARY, type FilePin } from '../asr/pins.js';
import { asrPaths, modelFilePath } from '../asr/runtime.js';
import { zip } from './fixtures/docs.js';

// /proc/cpuinfo 는 실행 환경마다 다르다 — 이 파일만 테스트 값으로 바꾼다
const cpu = vi.hoisted(() => ({ info: '' }));
vi.mock('node:fs', async (orig) => {
  const fs = await orig<typeof import('node:fs')>();
  return {
    ...fs,
    readFileSync: ((path: string, ...rest: never[]) =>
      path === '/proc/cpuinfo' ? cpu.info : fs.readFileSync(path, ...rest)) as typeof fs.readFileSync,
  };
});
// GPU 설치의 uv 실행은 기록만 하고 종료 코드를 흉내 낸다
const spawned = vi.hoisted(() => ({
  calls: [] as { cmd: string; args: string[]; env: Record<string, string> }[],
  code: 0,
}));
vi.mock('node:child_process', async (orig) => ({
  ...(await orig<typeof import('node:child_process')>()),
  spawn: (cmd: string, args: string[], opts: { env: Record<string, string> }) => {
    spawned.calls.push({ cmd, args, env: opts.env });
    const child = new EventEmitter();
    setImmediate(() => child.emit('exit', spawned.code));
    return child;
  },
}));

const V3 = 'flags\t\t: fpu sse2 avx avx2 fma bmi1 bmi2 abm movbe f16c\n';
const sha = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');

const setPlatform = (platform: NodeJS.Platform, arch: NodeJS.Architecture) => {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
  Object.defineProperty(process, 'arch', { value: arch, configurable: true });
};
const real = { platform: process.platform, arch: process.arch, path: process.env.PATH };

// 실제 고정값(수백 MB)을 작은 가짜 파일의 해시로 바꾸고 테스트 뒤 되돌린다
const pins: FilePin[] = [
  ...Object.values(QWEN_ASR_BINARY),
  ...Object.values(FFMPEG),
  ...Object.values(MODELS).flatMap((m) => Object.values(m.files)),
];
const saved = pins.map((p) => ({ ...p }));
// URL → 응답 본문
let served: Map<string, Buffer>;
const fetchMock = vi.fn((url: URL | string) => {
  const body = served.get(String(url));
  return Promise.resolve(body ? new Response(new Uint8Array(body)) : new Response('not found', { status: 404 }));
});

function serve(platform: 'linux-x64' | 'macos-arm64', model: '0.6b' | '1.7b') {
  served = new Map();
  const put = (url: string, pin: FilePin, body: Buffer) => {
    Object.assign(pin, { sha256: sha(body), maxBytes: body.length });
    served.set(url, body);
  };
  const ff = FFMPEG[platform];
  const ffmpegBin = Buffer.from('ffmpeg-binary');
  ff.entrySha256 = sha(ffmpegBin);
  put(ff.url, ff, zip({ [ff.entry]: ffmpegBin, 'other.txt': 'x' }));
  put(QWEN_ASR_BINARY[platform].url, QWEN_ASR_BINARY[platform], Buffer.from('qwen_asr-binary'));
  for (const [file, pin] of Object.entries(MODELS[model].files))
    put(modelFileUrl(model, file), pin, Buffer.from(`model ${file}`));
  return { ffmpegBin };
}

let root: string;
beforeEach(async () => {
  root = join(await mkdtemp(join(tmpdir(), 'asr-install-')), 'asr');
  cpu.info = V3;
  spawned.calls = [];
  spawned.code = 0;
  fetchMock.mockClear();
  vi.stubGlobal('fetch', fetchMock);
  setPlatform('darwin', 'arm64');
});
afterEach(async () => {
  setPlatform(real.platform, real.arch);
  process.env.PATH = real.path;
  pins.forEach((p, i) => Object.assign(p, saved[i]));
  vi.unstubAllGlobals();
  await rm(join(root, '..'), { recursive: true, force: true });
});

describe('detectPlatform', () => {
  it('Linux x64·Apple Silicon 만 지원하고 나머지는 이유와 함께 거부', () => {
    expect(detectPlatform()).toBe('macos-arm64');
    setPlatform('linux', 'x64');
    expect(detectPlatform()).toBe('linux-x64');
    for (const [platform, arch] of [
      ['darwin', 'x64'],
      ['win32', 'x64'],
      ['linux', 'arm64'],
    ] as const) {
      setPlatform(platform, arch);
      expect(() => detectPlatform()).toThrow('Intel Mac 미지원');
    }
  });

  it('x86-64-v3 기능이 없는 Linux CPU 는 빠진 기능을 알리며 거부', () => {
    setPlatform('linux', 'x64');
    cpu.info = 'flags\t\t: fpu sse2 avx fma bmi1 bmi2 abm movbe f16c\n';
    expect(() => detectPlatform()).toThrow('avx2 를 지원하지 않아');
  });
});

describe('checkInstallable', () => {
  it('GPU 는 Linux x64 에서만, uv 가 없으면 받기 전에 거부', async () => {
    expect(() => checkInstallable({ runtime: 'gpu', model: '0.6b' })).toThrow('NVIDIA GPU');
    setPlatform('linux', 'x64');
    process.env.PATH = join(root, '..');
    expect(() => checkInstallable({ runtime: 'gpu', model: '0.6b' })).toThrow('uv 가 필요합니다');
    await writeFile(join(root, '..', 'uv'), '');
    expect(checkInstallable({ runtime: 'gpu', model: '0.6b' })).toBe('linux-x64');
  });

  it('받을 크기는 CPU 만 qwen_asr 바이너리를 더한다', () => {
    const cpuBytes = estimateBytes({ runtime: 'cpu', model: '0.6b' }, 'linux-x64');
    const gpuBytes = estimateBytes({ runtime: 'gpu', model: '0.6b' }, 'linux-x64');
    expect(cpuBytes - gpuBytes).toBe(QWEN_ASR_BINARY['linux-x64'].maxBytes);
  });
});

describe('installAsr', () => {
  it('CPU 설치는 ffmpeg(휠에서 꺼냄)·qwen_asr·모델을 받고 마지막에 설정을 쓴다', async () => {
    const { ffmpegBin } = serve('macos-arm64', '0.6b');
    const phases: string[] = [];
    await installAsr({ runtime: 'cpu', model: '0.6b' }, root, (phase, file) => file || phases.push(phase));
    const paths = asrPaths(root);
    expect(phases).toEqual(['ffmpeg', 'qwen_asr', 'model']);
    expect(await readFile(paths.ffmpeg)).toEqual(ffmpegBin);
    expect(await readFile(paths.qwenAsr, 'utf8')).toBe('qwen_asr-binary');
    for (const file of Object.keys(MODELS['0.6b'].files))
      expect(await readFile(modelFilePath(root, '0.6b', file), 'utf8')).toBe(`model ${file}`);
    expect(JSON.parse(await readFile(paths.config, 'utf8'))).toEqual({ runtime: 'cpu', model: '0.6b' });
    // 휠·임시 파일은 남기지 않는다
    expect((await readdir(paths.bin)).sort()).toEqual(['ffmpeg', 'qwen_asr']);
  });

  it('다시 실행하면 이미 검증된 파일은 받지 않는다', async () => {
    serve('macos-arm64', '0.6b');
    await installAsr({ runtime: 'cpu', model: '0.6b' }, root);
    fetchMock.mockClear();
    await installAsr({ runtime: 'cpu', model: '0.6b' }, root);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('휠에서 꺼낸 ffmpeg 해시가 다르면 설정을 쓰지 않고 실패', async () => {
    serve('macos-arm64', '0.6b');
    FFMPEG['macos-arm64'].entrySha256 = sha('다른 바이너리');
    await expect(installAsr({ runtime: 'cpu', model: '0.6b' }, root)).rejects.toThrow('ffmpeg 의 sha256');
    expect((await readdir(root)).includes('config.json')).toBe(false);
  });

  it('GPU 설치는 uv 로 해시 고정·휠 전용 venv 를 이 폴더 안에 만들고 모델을 받는다', async () => {
    setPlatform('linux', 'x64');
    serve('linux-x64', '1.7b');
    const bin = join(root, '..');
    await writeFile(join(bin, 'uv'), '');
    process.env.PATH = bin;
    await installAsr({ runtime: 'gpu', model: '1.7b' }, root);
    expect(spawned.calls.map((c) => [c.cmd, c.args[0]])).toEqual([
      [join(bin, 'uv'), 'venv'],
      [join(bin, 'uv'), 'pip'],
    ]);
    expect(spawned.calls[1].args).toEqual(
      expect.arrayContaining(['--no-config', '--require-hashes', '--only-binary', ':all:'])
    );
    expect(spawned.calls[0].env).toMatchObject({ UV_CACHE_DIR: join(root, 'uv-cache') });
    // qwen_asr 바이너리는 받지 않는다
    expect(fetchMock.mock.calls.map(([u]) => String(u))).not.toContain(QWEN_ASR_BINARY['linux-x64'].url);
    expect(JSON.parse(await readFile(asrPaths(root).config, 'utf8'))).toEqual({ runtime: 'gpu', model: '1.7b' });
  });

  it('uv 가 실패하면 종료 코드를 알리고 설정을 쓰지 않는다', async () => {
    setPlatform('linux', 'x64');
    serve('linux-x64', '0.6b');
    await writeFile(join(root, '..', 'uv'), '');
    process.env.PATH = join(root, '..');
    spawned.code = 2;
    await expect(installAsr({ runtime: 'gpu', model: '0.6b' }, root)).rejects.toThrow('venv 실패 (종료 코드 2)');
    expect((await readdir(root)).includes('config.json')).toBe(false);
  });
});
