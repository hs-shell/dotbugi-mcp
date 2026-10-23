import { existsSync, readFileSync } from 'node:fs';
import { availableParallelism, homedir } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { MODELS, type AsrModel } from './pins.js';

export const ASR_ROOT = join(homedir(), '.cache', 'dotbugi-mcp', 'asr');
// 빌드 시 dist/asr/ 로 복사된다 (package.json build)
export const GPU_SCRIPT = fileURLToPath(new URL('./gpu_transcribe.py', import.meta.url));

export const asrPaths = (root: string) => ({
  config: join(root, 'config.json'),
  bin: join(root, 'bin'),
  ffmpeg: join(root, 'bin', 'ffmpeg'),
  qwenAsr: join(root, 'bin', 'qwen_asr'),
  models: join(root, 'models'),
  venv: join(root, 'venv'),
  venvPython: join(root, 'venv', 'bin', 'python'),
});

// 고정 목록의 파일 이름만 쓰지만, 경로 구분자·'..' 가 섞이면 모델 폴더 밖을 가리키므로 막는다
export function modelFilePath(root: string, model: AsrModel, file: string): string {
  if (file !== basename(file) || file === '..' || file === '.') throw new Error(`잘못된 모델 파일 이름입니다: ${file}`);
  return join(asrPaths(root).models, model, file);
}

// CPU 는 0.6B 고정, 모델 선택은 GPU 설치에서만 (#17 결정)
export const asrConfigSchema = z
  .strictObject({ runtime: z.enum(['cpu', 'gpu']), model: z.enum(['0.6b', '1.7b']) })
  .refine((c) => c.runtime === 'gpu' || c.model === '0.6b', { message: 'CPU 런타임은 0.6b 모델만 씁니다.' });
export type AsrConfig = z.infer<typeof asrConfigSchema>;

// command + args 는 stdin 으로 16kHz mono s16le PCM 을 받아 stdout 에 받아쓴 글을 쓴다. env 는 process.env 위에 덧붙여 실행한다
export interface AsrRuntime {
  ffmpeg: string;
  kind: 'cpu' | 'gpu';
  command: string;
  args: string[];
  model: AsrModel;
  env: Record<string, string>;
}

const INSTALL_HINT = '`dotbugi-mcp asr install` 을 실행하세요.';

export function readAsrConfig(root: string): AsrConfig | null {
  let raw: string;
  try {
    raw = readFileSync(asrPaths(root).config, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
  let parsed;
  try {
    parsed = asrConfigSchema.safeParse(JSON.parse(raw));
  } catch {
    parsed = null;
  }
  if (!parsed?.success) throw new Error(`ASR 설정(config.json) 형식이 올바르지 않습니다. ${INSTALL_HINT}`);
  return parsed.data;
}

export function resolveAsrRuntime(root = ASR_ROOT): AsrRuntime {
  const config = readAsrConfig(root);
  if (!config) throw new Error(`로컬 음성 인식(ASR) 런타임이 설치되어 있지 않습니다. ${INSTALL_HINT}`);
  const paths = asrPaths(root);
  const modelDir = join(paths.models, config.model);
  const command = config.runtime === 'cpu' ? paths.qwenAsr : paths.venvPython;
  const required = [
    paths.ffmpeg,
    command,
    ...Object.keys(MODELS[config.model].files).map((f) => modelFilePath(root, config.model, f)),
  ];
  if (config.runtime === 'gpu') required.push(GPU_SCRIPT);
  const missing = required.find((p) => !existsSync(p));
  if (missing) throw new Error(`ASR 런타임 파일이 없습니다 (${missing}). ${INSTALL_HINT}`);

  if (config.runtime === 'gpu')
    return {
      ffmpeg: paths.ffmpeg,
      kind: 'gpu',
      command,
      // -I: 현재 폴더·사용자 site-packages·PYTHON* 환경변수를 무시한다
      args: ['-I', GPU_SCRIPT, modelDir, 'Korean'],
      model: config.model,
      env: { HF_HUB_OFFLINE: '1' },
    };
  // shortcut: 물리 코어 수 대신 논리 코어의 절반(SMT 가정), 상한 8 — POC(8코어)에서 -t 8 이 최적이었다
  const threads = Math.max(1, Math.min(8, Math.floor(availableParallelism() / 2)));
  return {
    ffmpeg: paths.ffmpeg,
    kind: 'cpu',
    command,
    args: ['-d', modelDir, '--stdin', '--language', 'Korean', '-S', '30', '-t', String(threads), '--silent'],
    model: '0.6b',
    // qwen_asr 가 스레드를 직접 나누므로 OpenBLAS 스레드는 겹치지 않게 1 개로
    env: { OPENBLAS_NUM_THREADS: '1' },
  };
}
