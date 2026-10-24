import { spawn } from 'node:child_process';
import { rename, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { checkInstallable, estimateBytes, parseInstallOptions } from '../asr/install.js';
import { ASR_ROOT, readAsrConfig, resolveAsrRuntime, type AsrConfig } from '../asr/runtime.js';
import {
  ASR_INSTALL_BUSY,
  ASR_INSTALL_LOCK_FILE,
  asrInstallStateSchema,
  readAsrInstallState,
  writeAsrInstallState,
  type AsrInstallState,
} from '../asr/state.js';
import { statusText } from '../commands/asr.js';
import { acquireLock, isAlive } from '../player/lock.js';
import { redact } from '../redact.js';

// dist/tools/ → dist/index.js
const ENTRY = fileURLToPath(new URL('../index.js', import.meta.url));
const PHASES: Record<NonNullable<AsrInstallState['phase']>, string> = {
  ffmpeg: '1/3 ffmpeg',
  qwen_asr: '2/3 qwen_asr',
  venv: '2/3 GPU venv (uv, 수 GB)',
  model: '3/3 모델',
};
const gb = (bytes: number) => `${(bytes / 1e9).toFixed(1)}GB`;

// 이미 같은 구성으로 쓸 수 있게 설치돼 있는지. 설정이 깨졌거나 파일이 빠졌으면 다시 설치한다
async function installed(config: AsrConfig, root: string): Promise<boolean> {
  try {
    const c = readAsrConfig(root);
    if (c?.runtime !== config.runtime || c.model !== config.model) return false;
    await resolveAsrRuntime(root);
    return true;
  } catch {
    return false;
  }
}

const INSTALL_DEPS = { spawn, check: checkInstallable, root: ASR_ROOT };

// 수 GB 를 받는다 — transcribe_vod 처럼 따로 떠 있는 작업 프로세스(셸 없이 인자 배열)로 넘기고 바로 돌아온다.
// 미지원 플랫폼·고정값 없음은 띄우기 전에 오류로, 이미 설치됨·설치 중은 안내로 돌려준다
export async function startInstall(opts: { gpu: boolean; model?: string }, deps = INSTALL_DEPS): Promise<string> {
  const config = parseInstallOptions(opts);
  const platform = deps.check(config);
  if (await installed(config, deps.root))
    return `이미 설치돼 있습니다 (${config.runtime} · ${config.model}). 상태는 asr_status 로 확인하세요.`;
  let release;
  try {
    release = await acquireLock(ASR_INSTALL_LOCK_FILE, ASR_INSTALL_BUSY);
  } catch (err) {
    if (err instanceof Error && err.message === ASR_INSTALL_BUSY) return ASR_INSTALL_BUSY;
    throw err;
  }
  try {
    const flags = config.runtime === 'gpu' ? ['--gpu', '--model', config.model] : [];
    const child = deps.spawn(process.execPath, [ENTRY, 'asr', 'install', '--worker', ...flags], {
      detached: true,
      stdio: 'ignore',
    });
    await new Promise<void>((resolve, reject) => {
      child.once('spawn', resolve);
      child.once('error', reject);
    });
    // 잠금 파일의 pid 를 작업 프로세스로 바꾼다 — 임시 파일 + rename (transcribe_vod 와 같은 이유)
    const tmp = `${ASR_INSTALL_LOCK_FILE}.${process.pid}.tmp`;
    await writeFile(tmp, String(child.pid), { mode: 0o600 });
    await rename(tmp, ASR_INSTALL_LOCK_FILE);
    child.unref();
    // 시작 직후 asr_status 가 이전 설치 결과를 보여주지 않게 바로 기록한다 (작업 프로세스가 이어서 갱신)
    await writeAsrInstallState({
      version: 1,
      status: 'running',
      ...config,
      phase: null,
      file: null,
      pid: child.pid!,
      updatedAt: new Date().toISOString(),
      message: null,
    }).catch(() => {});
  } catch (err) {
    await release();
    throw err;
  }
  const extra = config.runtime === 'gpu' ? ' + GPU 패키지 수 GB' : '';
  return (
    `ASR 설치를 시작했습니다 (${config.runtime} · ${config.model}, 최대 약 ${gb(estimateBytes(config, platform))}${extra}). ` +
    '진행은 asr_status 로 확인하세요.'
  );
}

function jobText(job: AsrInstallState & { stale: boolean }): string {
  const file =
    job.file && `${job.file.label} ${(job.file.done / 1e6).toFixed(0)}/${(job.file.total / 1e6).toFixed(0)}MB`;
  return [
    `설치 작업: [${job.stale ? 'stale' : job.status}] ${job.runtime} · ${job.model}`,
    job.phase && `단계: ${PHASES[job.phase]}`,
    file,
    job.stale && '작업 프로세스가 없습니다 (강제 종료 등). asr_install 을 다시 부르면 이어 받습니다.',
    job.message,
  ]
    .filter(Boolean)
    .join('\n');
}

// 설치된 구성요소(asr status 와 같은 내용) + 설치 작업 상태 파일
export async function asrStatus(root = ASR_ROOT) {
  const s = readAsrInstallState();
  const job = s && { ...s, stale: s.status === 'running' && !isAlive(s.pid) };
  const text = [await statusText(root).catch((err: Error) => err.message), job && jobText(job)]
    .filter(Boolean)
    .join('\n\n');
  return { text: redact(text), job };
}

export function registerAsrTools(server: McpServer): void {
  server.registerTool(
    'asr_install',
    {
      title: '로컬 음성 인식(ASR) 설치 시작',
      description:
        'transcribe_vod 가 쓰는 로컬 음성 인식(Qwen3-ASR) 런타임을 ~/.cache/dotbugi-mcp/asr 에 설치하는 백그라운드 작업을 시작하고 바로 돌아온다. ' +
        '수 GB 를 받으며 모든 파일은 코드에 고정된 sha256 으로 검증한다. 진행은 asr_status. 중단돼도 다시 부르면 이어 받는다.',
      inputSchema: z.object({
        gpu: z.boolean().default(false).describe('NVIDIA GPU(Linux·WSL) 런타임. uv 가 필요하다'),
        model: z.enum(['0.6b', '1.7b']).optional().describe('모델 (기본 0.6b). 1.7b 는 gpu 와 함께만'),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ gpu, model }) => {
      try {
        return { content: [{ type: 'text', text: await startInstall({ gpu, model }) }] };
      } catch (err) {
        return {
          content: [{ type: 'text', text: redact(err instanceof Error ? err.message : String(err)) }],
          isError: true,
        };
      }
    }
  );

  server.registerTool(
    'asr_status',
    {
      title: '로컬 음성 인식(ASR) 설치 상태',
      description:
        '설치된 ASR 구성요소(ffmpeg·qwen_asr·모델·GPU venv)의 용량·해시 검증 결과와, 진행 중이거나 마지막 asr_install 작업의 진행률·오류를 보여준다.',
      inputSchema: z.object({}),
      outputSchema: z.object({
        job: asrInstallStateSchema
          .extend({ stale: z.boolean().describe('실행 중으로 남았지만 프로세스가 없음 (강제 종료 등)') })
          .nullable(),
      }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () => {
      const { text, job } = await asrStatus();
      return { content: [{ type: 'text', text }], structuredContent: { job } };
    }
  );
}
