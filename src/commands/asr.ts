import { existsSync } from 'node:fs';
import { lstat, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileSha256 } from '../asr/download.js';
import { installAsr, parseInstallOptions, type InstallReport } from '../asr/install.js';
import { FFMPEG, MODELS, QWEN_ASR_BINARY, type AsrModel, type AsrPlatform } from '../asr/pins.js';
import { ASR_ROOT, asrPaths, INSTALL_HINT, modelFilePath, readAsrConfig, type AsrConfig } from '../asr/runtime.js';
import { ASR_INSTALL_BUSY, ASR_INSTALL_LOCK_FILE, writeAsrInstallState, type AsrInstallState } from '../asr/state.js';
import { log } from '../log.js';
import { paint } from './paint.js';
import { acquireLock, adoptLock } from '../player/lock.js';
import { redact } from '../redact.js';
import { TRANSCRIBE_LOCK_FILE } from '../transcribe/state.js';

export const ASR_USAGE = `사용법:
  dotbugi-mcp asr install [--gpu] [--model 0.6b|1.7b]   로컬 음성 인식 런타임 설치 (CPU 는 0.6b 고정, --model 은 --gpu 와 함께)
  dotbugi-mcp asr status                               설치 상태·용량·검증 결과
  dotbugi-mcp asr remove [--yes]                       ${ASR_ROOT} 삭제`;

interface AsrOptions {
  gpu?: boolean;
  model?: string;
  yes?: boolean;
  worker?: boolean;
}

export async function asr(args: string[], opts: AsrOptions, root = ASR_ROOT): Promise<void> {
  const [sub, ...rest] = args;
  const installOnly = opts.gpu || opts.model !== undefined;
  if (rest.length > 0 || ((installOnly || opts.worker) && sub !== 'install') || (opts.yes && sub !== 'remove'))
    throw new Error(ASR_USAGE);
  if (sub === 'install') return install(parseInstallOptions(opts), root, opts.worker ?? false);
  if (sub === 'status') return log(await statusText(root));
  if (sub === 'remove') return remove(root, opts.yes ?? false);
  throw new Error(ASR_USAGE);
}

// 포그라운드 CLI 와 asr_install 이 띄운 작업 프로세스(worker: 잠금은 도구가 넘겨준다)가 같이 쓴다.
// 둘이 동시에 같은 .part 에 쓰지 않게 잠그고, 진행은 asr_status 가 읽도록 상태 파일에 남긴다
async function install(config: AsrConfig, root: string, worker: boolean): Promise<void> {
  const release = worker
    ? await adoptLock(ASR_INSTALL_LOCK_FILE)
    : await acquireLock(ASR_INSTALL_LOCK_FILE, ASR_INSTALL_BUSY);
  let current: Pick<AsrInstallState, 'status' | 'phase' | 'file' | 'message'> = {
    status: 'running',
    phase: null,
    file: null,
    message: null,
  };
  let writes = Promise.resolve();
  let lastWrite = 0;
  const save = (patch: Partial<typeof current>, force = true) => {
    current = { ...current, ...patch };
    // 받는 중에는 조각마다 불린다 — 상태 파일은 1초에 한 번만 쓴다
    if (!force && Date.now() - lastWrite < 1000) return;
    lastWrite = Date.now();
    const state = { version: 1 as const, ...current, ...config, pid: process.pid, updatedAt: new Date().toISOString() };
    // 상태 쓰기는 같은 임시 파일을 쓰므로 차례로
    writes = writes.then(() => writeAsrInstallState(state)).catch(() => {});
  };
  const report: InstallReport = (phase, file) => save({ phase, file }, file === null);
  save({});
  try {
    await installAsr(config, root, report);
    save({ status: 'done', phase: null, file: null, message: '설치를 마쳤습니다.' });
  } catch (err) {
    const message = redact(err instanceof Error ? err.message : String(err));
    save({ status: 'error', message });
    throw new Error(message);
  } finally {
    await writes;
    await release();
  }
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

// asr status 와 asr_status 도구가 같이 쓴다. 해시는 수 GB 를 읽으므로 도구는 요청할 때만 (CLI 는 항상)
export async function statusText(root = ASR_ROOT, opts = { verify: true }): Promise<string> {
  if (!existsSync(root)) return `설치된 ASR 런타임이 없습니다. ${INSTALL_HINT}`;
  const ok = opts.verify ? '검증 OK' : '있음 (해시 검증 생략)';
  const verify = async (path: string, sha256: string): Promise<string> => {
    if (!opts.verify) return existsSync(path) ? ok : '없음';
    const actual = await fileSha256(path);
    if (actual === null) return '없음';
    return actual === sha256 ? ok : `해시 불일치 — 다시 설치하세요 (${INSTALL_HINT})`;
  };
  const lines: string[] = [];
  const paths = asrPaths(root);
  let config: string;
  try {
    const c = readAsrConfig(root);
    config = c ? `${c.runtime} · ${c.model}` : `설치 미완료 — ${INSTALL_HINT}`;
  } catch (err) {
    config = (err as Error).message;
  }
  lines.push(`위치: ${root}`, `설정: ${config}`);
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
    lines.push(`- ${name}: ${mb(await sizeOf(path))} ${result}`);
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
    const bad = results.filter((r) => !r.endsWith(ok));
    lines.push(`- 모델 ${model}: ${mb(await sizeOf(join(paths.models, model)))} ${bad.length ? bad.join(', ') : ok}`);
  }
  if (existsSync(paths.venv)) lines.push(`- GPU venv: ${mb(await sizeOf(paths.venv))} (패키지는 설치 때 해시 검증)`);
  lines.push(`합계: ${mb(await sizeOf(root))}`);
  return lines.join('\n');
}

async function remove(root: string, yes: boolean): Promise<void> {
  if (!existsSync(root)) return log('설치된 ASR 런타임이 없습니다.');
  if (!yes) {
    if (!process.stdin.isTTY) throw new Error('터미널이 아니면 확인할 수 없습니다. 지우려면 --yes 를 붙이세요.');
    const rl = createInterface({ input: process.stdin, output: process.stderr });
    const answer = await rl.question(`${root} 를 삭제할까요? [y/N] `).finally(() => rl.close());
    if (!['y', 'yes'].includes(answer.trim().toLowerCase())) return log(paint('dim', '취소했습니다.'));
  }
  await deleteAsrRoot(root);
  log(`${paint('green', '✓ 삭제했습니다:')} ${root}`);
}

const TRANSCRIBE_RUNNING = 'STT 변환이 실행 중이라 지우지 않았습니다. 끝난 뒤 다시 실행하세요.';
export const ASR_REMOVE_LOCKS: [file: string, busy: string][] = [
  [ASR_INSTALL_LOCK_FILE, ASR_INSTALL_BUSY],
  [TRANSCRIBE_LOCK_FILE, TRANSCRIBE_RUNNING],
];

// CLI·asr_remove 공용. 설치·받아쓰기 중에 지우면 작업 프로세스가 반쯤 지워진 폴더에 이어 쓰므로 잠금을 다 잡은 채로만 지운다.
// 폴더가 링크여도 rm 은 링크만 지우고 대상은 건드리지 않는다
export async function deleteAsrRoot(root: string, locks = ASR_REMOVE_LOCKS): Promise<void> {
  const releases: (() => Promise<void>)[] = [];
  try {
    for (const [file, busy] of locks) releases.push(await acquireLock(file, busy));
    await rm(root, { recursive: true, force: true });
  } finally {
    for (const release of releases) await release();
  }
}
