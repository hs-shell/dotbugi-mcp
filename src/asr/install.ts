import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { chmod, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { log } from '../log.js';
import { absolutePathDirs } from '../platform.js';
import { ensurePrivateDir } from '../player/state.js';
import { assertPinned, download, fileSha256 } from './download.js';
import {
  FFMPEG,
  GPU_PYTHON_VERSION,
  MODELS,
  modelFileUrl,
  PYPI_INDEX,
  QWEN_ASR_BINARY,
  type AsrModel,
  type AsrPlatform,
} from './pins.js';
import { asrConfigSchema, asrPaths, modelFilePath, type AsrConfig } from './runtime.js';
import { extractZipEntry } from './zip.js';

const GPU_REQUIREMENTS = fileURLToPath(new URL('./gpu-requirements.txt', import.meta.url));

// CPU 는 0.6B 고정. --model 은 --gpu 와 함께일 때만 받는다 (#17 결정: 자동 선택 없음)
export function parseInstallOptions(opts: { gpu?: boolean; model?: string }): AsrConfig {
  if (!opts.gpu && opts.model !== undefined)
    throw new Error('--model 은 --gpu 와 함께만 쓸 수 있습니다 (CPU 는 0.6b 고정).');
  const parsed = asrConfigSchema.safeParse({ runtime: opts.gpu ? 'gpu' : 'cpu', model: opts.model ?? '0.6b' });
  if (!parsed.success) throw new Error('--model 은 0.6b 또는 1.7b 입니다.');
  return parsed.data;
}

// 미리 빌드한 qwen_asr 는 -march=x86-64-v3 — 이 기능이 없는 CPU 에서는 실행 중 SIGILL 로 죽는다 (abm = LZCNT)
const X86_64_V3_FLAGS = ['avx2', 'fma', 'bmi1', 'bmi2', 'abm', 'movbe', 'f16c'];

export function missingCpuFlags(cpuinfo: string): string[] {
  const flags = new Set(/^flags\s*:(.*)$/m.exec(cpuinfo)?.[1].trim().split(/\s+/));
  return X86_64_V3_FLAGS.filter((f) => !flags.has(f));
}

export function detectPlatform(): AsrPlatform {
  if (process.platform === 'linux' && process.arch === 'x64') {
    const missing = missingCpuFlags(readFileSync('/proc/cpuinfo', 'utf8'));
    if (missing.length)
      throw new Error(`이 CPU 는 ${missing.join('·')} 를 지원하지 않아 로컬 ASR 을 쓸 수 없습니다 (x86-64-v3 필요).`);
    return 'linux-x64';
  }
  if (process.platform === 'darwin' && process.arch === 'arm64') return 'macos-arm64';
  throw new Error('로컬 ASR 은 Linux(x64)·WSL·macOS(Apple Silicon) 만 지원합니다. Windows 는 WSL 에서 실행하세요.');
}

function run(command: string, args: string[], env: Record<string, string>): Promise<void> {
  return new Promise((resolve, reject) => {
    // 셸 없이 인자 배열로. 자식의 stdout 도 stderr 로 보낸다 (stdout 은 비워 둔다)
    const child = spawn(command, args, {
      stdio: ['ignore', process.stderr, process.stderr],
      env: { ...process.env, ...env },
    });
    child.once('error', reject);
    child.once('exit', (code) =>
      code === 0 ? resolve() : reject(new Error(`${command} ${args[0]} 실패 (종료 코드 ${code})`))
    );
  });
}

async function installFfmpeg(root: string, platform: AsrPlatform): Promise<void> {
  const pin = FFMPEG[platform];
  const { ffmpeg, bin } = asrPaths(root);
  const wheel = join(bin, 'ffmpeg.whl');
  if ((await fileSha256(ffmpeg)) === pin.entrySha256) return rm(wheel, { force: true });
  await download(pin.url, wheel, pin, 'ffmpeg');
  const data = extractZipEntry(await readFile(wheel), pin.entry);
  if (createHash('sha256').update(data).digest('hex') !== pin.entrySha256)
    throw new Error('휠에서 꺼낸 ffmpeg 의 sha256 이 고정값과 다릅니다.');
  const tmp = `${ffmpeg}.part`;
  await writeFile(tmp, data, { mode: 0o700 });
  await rename(tmp, ffmpeg);
  await rm(wheel);
}

async function installModel(root: string, model: AsrModel): Promise<void> {
  await ensurePrivateDir(join(asrPaths(root).models, model));
  for (const [file, pin] of Object.entries(MODELS[model].files))
    await download(modelFileUrl(model, file), modelFilePath(root, model, file), pin, `모델 ${model} ${file}`);
}

async function installGpuVenv(root: string): Promise<void> {
  const uv = absolutePathDirs()
    .map((d) => join(d, 'uv'))
    .find((p) => existsSync(p));
  if (!uv) throw new Error('--gpu 설치에는 uv 가 필요합니다: https://docs.astral.sh/uv/getting-started/installation/');
  const { venv, venvPython } = asrPaths(root);
  // uv 캐시·uv 가 받는 Python 도 이 폴더 안에 두어 asr remove 가 전부 지우게 한다
  const env = { UV_CACHE_DIR: join(root, 'uv-cache'), UV_PYTHON_INSTALL_DIR: join(root, 'python') };
  // --no-config: 사용자 uv 설정의 다른 인덱스를 쓰지 않게. 패키지는 해시 고정 + 휠만 (sdist 빌드 스크립트 실행 안 함)
  await run(uv, ['venv', '--no-config', '--allow-existing', '--python', GPU_PYTHON_VERSION, venv], env);
  await run(
    uv,
    [
      'pip',
      'install',
      '--no-config',
      '--python',
      venvPython,
      '--index-url',
      PYPI_INDEX,
      '--require-hashes',
      '--only-binary',
      ':all:',
      '-r',
      GPU_REQUIREMENTS,
    ],
    env
  );
}

// 이미 검증된 파일은 건너뛰므로 중단 후 다시 실행해도 된다. config.json 은 모든 구성요소가 갖춰진 뒤 마지막에 쓴다
export async function installAsr(config: AsrConfig, root: string): Promise<void> {
  const platform = detectPlatform();
  if (config.runtime === 'gpu' && platform !== 'linux-x64')
    throw new Error('--gpu 는 NVIDIA GPU 가 있는 Linux(x64)·WSL 에서만 지원합니다.');
  // 받기 전에 확인 — 고정값이 없으면 아무것도 받지 않는다
  if (config.runtime === 'cpu') assertPinned(QWEN_ASR_BINARY[platform].sha256, 'qwen_asr 바이너리');
  const paths = asrPaths(root);
  await ensurePrivateDir(root);
  await ensurePrivateDir(paths.bin);

  log('[1/3] ffmpeg');
  await installFfmpeg(root, platform);
  if (config.runtime === 'cpu') {
    log('[2/3] qwen_asr');
    const pin = QWEN_ASR_BINARY[platform];
    await download(pin.url, paths.qwenAsr, pin, 'qwen_asr');
    await chmod(paths.qwenAsr, 0o700);
  } else {
    log('[2/3] GPU venv (uv, 수 GB)');
    await installGpuVenv(root);
  }
  log(`[3/3] 모델 ${config.model}`);
  await installModel(root, config.model);

  const tmp = `${paths.config}.${process.pid}.tmp`;
  await writeFile(tmp, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  await rename(tmp, paths.config);
  log(`설치를 마쳤습니다: ${config.runtime} · ${config.model} (${root})`);
}
