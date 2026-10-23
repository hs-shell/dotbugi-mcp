import { existsSync } from 'node:fs';
import { lstat, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileSha256 } from '../asr/download.js';
import { installAsr, parseInstallOptions } from '../asr/install.js';
import { FFMPEG, MODELS, QWEN_ASR_BINARY, type AsrModel, type AsrPlatform } from '../asr/pins.js';
import { ASR_ROOT, asrPaths, modelFilePath, readAsrConfig } from '../asr/runtime.js';
import { log } from '../log.js';

export const ASR_USAGE = `사용법:
  dotbugi-mcp asr install [--gpu] [--model 0.6b|1.7b]   로컬 음성 인식 런타임 설치 (CPU 는 0.6b 고정, --model 은 --gpu 와 함께)
  dotbugi-mcp asr status                               설치 상태·용량·검증 결과
  dotbugi-mcp asr remove [--yes]                       ${ASR_ROOT} 삭제`;

interface AsrOptions {
  gpu?: boolean;
  model?: string;
  yes?: boolean;
}

export async function asr(args: string[], opts: AsrOptions, root = ASR_ROOT): Promise<void> {
  const [sub, ...rest] = args;
  const installOnly = opts.gpu || opts.model !== undefined;
  if (rest.length > 0 || (installOnly && sub !== 'install') || (opts.yes && sub !== 'remove'))
    throw new Error(ASR_USAGE);
  if (sub === 'install') return installAsr(parseInstallOptions(opts), root);
  if (sub === 'status') return status(root);
  if (sub === 'remove') return remove(root, opts.yes ?? false);
  throw new Error(ASR_USAGE);
}

async function sizeOf(path: string): Promise<number> {
  const st = await lstat(path).catch(() => null);
  if (!st?.isDirectory()) return st?.size ?? 0;
  const entries = await readdir(path, { recursive: true, withFileTypes: true });
  const sizes = await Promise.all(
    entries.filter((e) => e.isFile()).map((e) => lstat(join(e.parentPath, e.name)).then((s) => s.size))
  );
  return sizes.reduce((a, b) => a + b, 0);
}

const mb = (bytes: number) => `${(bytes / 1e6).toFixed(0)}MB`;

async function verify(path: string, sha256: string): Promise<string> {
  const actual = await fileSha256(path);
  if (actual === null) return '없음';
  return actual === sha256 ? '검증 OK' : '해시 불일치 — asr install 로 다시 받으세요';
}

async function status(root: string): Promise<void> {
  if (!existsSync(root)) return log(`설치된 ASR 런타임이 없습니다. \`dotbugi-mcp asr install\` 로 설치하세요.`);
  const paths = asrPaths(root);
  let config: string;
  try {
    const c = readAsrConfig(root);
    config = c ? `${c.runtime} · ${c.model}` : '설치 미완료 (asr install 을 다시 실행하세요)';
  } catch (err) {
    config = (err as Error).message;
  }
  log(`위치: ${root}\n설정: ${config}`);
  // 이 플랫폼의 고정값으로 검증한다. 미지원 플랫폼이면 바이너리는 검증할 수 없다고만 알린다
  const platform: AsrPlatform | null =
    process.platform === 'linux' && process.arch === 'x64'
      ? 'linux-x64'
      : process.platform === 'darwin' && process.arch === 'arm64'
        ? 'macos-arm64'
        : null;
  const binary = async (name: string, path: string, sha256: string | undefined) => {
    if (!existsSync(path)) return;
    const result = sha256
      ? await verify(path, sha256)
      : `미지원 플랫폼(${process.platform}-${process.arch}) — 검증 불가`;
    log(`- ${name}: ${mb(await sizeOf(path))} ${result}`);
  };
  await binary('ffmpeg', paths.ffmpeg, platform ? FFMPEG[platform].entrySha256 : undefined);
  await binary('qwen_asr', paths.qwenAsr, platform ? QWEN_ASR_BINARY[platform].sha256 : undefined);
  for (const model of Object.keys(MODELS) as AsrModel[]) {
    if (!existsSync(join(paths.models, model))) continue;
    const results = await Promise.all(
      Object.entries(MODELS[model].files).map(
        async ([f, pin]) => `${f}: ${await verify(modelFilePath(root, model, f), pin.sha256)}`
      )
    );
    const bad = results.filter((r) => !r.endsWith('검증 OK'));
    log(`- 모델 ${model}: ${mb(await sizeOf(join(paths.models, model)))} ${bad.length ? bad.join(', ') : '검증 OK'}`);
  }
  if (existsSync(paths.venv)) log(`- GPU venv: ${mb(await sizeOf(paths.venv))} (패키지는 설치 때 해시 검증)`);
  log(`합계: ${mb(await sizeOf(root))}`);
}

async function remove(root: string, yes: boolean): Promise<void> {
  if (!existsSync(root)) return log('설치된 ASR 런타임이 없습니다.');
  if (!yes) {
    if (!process.stdin.isTTY) throw new Error('터미널이 아니면 확인할 수 없습니다. 지우려면 --yes 를 붙이세요.');
    const rl = createInterface({ input: process.stdin, output: process.stderr });
    const answer = await rl.question(`${root} 를 삭제할까요? [y/N] `).finally(() => rl.close());
    if (!['y', 'yes'].includes(answer.trim().toLowerCase())) return log('취소했습니다.');
  }
  // 폴더가 링크여도 rm 은 링크만 지우고 대상은 건드리지 않는다
  await rm(root, { recursive: true, force: true });
  log(`삭제했습니다: ${root}`);
}
