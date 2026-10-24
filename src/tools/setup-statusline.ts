import { chmod, mkdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { randomUUID } from 'node:crypto';
import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { replaceFile } from '../player/state.js';
import { redact } from '../redact.js';
import { askerOf, confirmDestructive, confirmTokenInput, type Asker } from './confirm.js';

// Claude Code 사용자 설정만 다룬다 (프로젝트 설정은 저장소에 커밋될 수 있어 건드리지 않는다). CLAUDE_CONFIG_DIR 이 ~/.claude 를 대신한다
export const userSettingsFile = () =>
  join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'settings.json');

// dist/tools/ 에서 한 단계 위가 CLI 진입점
const ENTRY = fileURLToPath(new URL('../index.js', import.meta.url));

// 상태 표시줄은 자주 실행되므로 npx(패키지 확인으로 느림) 대신 node 와 진입점을 절대 경로로 직접 부른다
export function statusLineCommand(node = process.execPath, entry = ENTRY, platform = process.platform): string {
  if (platform === 'win32') {
    // Windows 는 Git Bash(없으면 PowerShell)로 실행된다 — 역슬래시는 Git Bash 가 이스케이프로 먹으므로 / 로 바꾼다
    // shortcut: Git Bash 없이 PowerShell 로 돌면 따옴표 붙은 경로 실행에 & 가 필요해 동작하지 않는다, 제보가 오면 분기 추가
    const q = (s: string) => {
      if (/["$`]/.test(s)) throw new Error(`경로에 셸 특수문자가 있어 설정할 수 없습니다: ${s}`);
      return `"${s.replaceAll('\\', '/')}"`;
    };
    return `${q(node)} ${q(entry)} statusline`;
  }
  // POSIX sh 작은따옴표 — 공백·$ 등 어떤 문자도 해석되지 않는다
  const q = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`;
  return `${q(node)} ${q(entry)} statusline`;
}

// 진행률이 살아 움직이게 상태 표시줄을 이 간격(초)으로 다시 그린다
const REFRESH_SECONDS = 2;
// enable 이 refreshInterval 을 바꿨으면 원래 값을 우리 줄 끝 인자로 남긴다 (settings.json 에 모르는 키를 더하지 않으려고).
// statusline 명령은 이 인자를 무시하고, disable 이 읽어 그대로 되돌린다
const REFRESH_WAS = /\s--refresh-was=(none|\d+)$/;

// 우리가 넣은 것(또는 문서대로 손으로 넣은 dotbugi-mcp statusline)만 우리 것으로 본다.
// 패키지 이름이 없는 폴더에서 실행해도 enable 이 지금 만드는 명령과 같으면 우리 것
export const isOurStatusLine = (v: unknown, current?: string): boolean => {
  const raw = (v as { command?: unknown } | null)?.command;
  if (typeof raw !== 'string') return false;
  const cmd = raw.trim().replace(REFRESH_WAS, '');
  return cmd === current || (/dotbugi-mcp|@dotbugi[\\/]mcp/.test(cmd) && /\sstatusline$/.test(cmd));
};

async function readRaw(file: string): Promise<string | null> {
  try {
    return await readFile(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

export async function setupStatusline(
  asker: Asker,
  action: 'enable' | 'disable',
  confirmToken: string | undefined,
  file = userSettingsFile(),
  command = statusLineCommand()
): Promise<string> {
  const raw = await readRaw(file);
  let settings: Record<string, unknown> = {};
  if (raw !== null && raw.trim() !== '') {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      // 주석(JSONC)·깨진 JSON 을 다시 쓰면 사용자 내용이 사라진다 — 고치지 않고 거절
      return `${file} 이 올바른 JSON 이 아니라(주석 포함) 바꾸지 않았습니다. 직접 고친 뒤 다시 시도하세요.`;
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))
      return `${file} 의 최상위가 객체가 아니라 바꾸지 않았습니다.`;
    settings = parsed as Record<string, unknown>;
  }
  const old = settings.statusLine;
  const next = { ...settings };
  // 이미 쓰는 상태 표시줄(사용자 스크립트)은 지우지 않고 그 뒤 줄에 우리 명령을 붙인다 — Claude Code 는 출력 여러 줄을 그대로 보여준다.
  // 줄바꿈으로 잇는다: ; 로 이으면 기존 명령 끝의 # 주석이 우리 명령까지 먹는다
  const oldCommand = (old as { type?: unknown; command?: unknown } | undefined)?.command;
  if (old !== undefined && ((old as { type?: unknown }).type !== 'command' || typeof oldCommand !== 'string'))
    return `${file} 의 statusLine 형식을 알 수 없어 바꾸지 않았습니다: ${JSON.stringify(old)}`;
  const lines = typeof oldCommand === 'string' ? oldCommand.split('\n') : [];
  const hasOurs = lines.length > 0 && isOurStatusLine({ command: lines.at(-1) }, command);
  const base = hasOurs ? lines.slice(0, -1) : lines;
  // 사용자가 원래 쓰던 refreshInterval — 전에 우리가 바꿨으면 우리 줄에 남긴 값
  const wasMatch = hasOurs ? REFRESH_WAS.exec(lines.at(-1)!.trim()) : null;
  const prev = (old ?? {}) as Record<string, unknown>;
  const was = wasMatch ? (wasMatch[1] === 'none' ? undefined : Number(wasMatch[1])) : prev.refreshInterval;
  if (action === 'enable') {
    // 없거나 느리면(정수 > 2초) 낮추고 원래 값을 기록한다. 알 수 없는 값은 건드리지 않는다
    const lower = was === undefined || (Number.isSafeInteger(was) && (was as number) > REFRESH_SECONDS);
    const desired = {
      type: 'command',
      ...prev,
      command: [...base, lower ? `${command} --refresh-was=${was ?? 'none'}` : command].join('\n'),
      refreshInterval: lower ? REFRESH_SECONDS : was,
    };
    if (isDeepStrictEqual(old, desired)) return `이미 설정돼 있습니다 (${file}).`;
    next.statusLine = desired;
  } else {
    if (old === undefined) return `${file} 에 설정된 상태 표시줄이 없습니다.`;
    if (!hasOurs) return `${file} 의 상태 표시줄에 dotbugi 가 넣은 줄이 없어 바꾸지 않았습니다: ${JSON.stringify(old)}`;
    // 우리 줄만 빼고 사용자 명령·refreshInterval 은 enable 전으로 되돌린다 (padding 등 다른 값은 그대로)
    if (base.length) {
      const restored: Record<string, unknown> = { ...prev, command: base.join('\n') };
      if (wasMatch) {
        if (was === undefined) delete restored.refreshInterval;
        else restored.refreshInterval = was;
      }
      next.statusLine = restored;
    } else delete next.statusLine;
  }
  const out = `${JSON.stringify(next, null, 2)}\n`;
  const targets = [
    file,
    `기존 statusLine: ${old === undefined ? '(없음)' : JSON.stringify(old)}`,
    `새 statusLine: ${next.statusLine === undefined ? '(없음)' : JSON.stringify(next.statusLine)}`,
  ];
  const confirmed = await confirmDestructive(asker, {
    action: 'setup_statusline',
    kind: 'change',
    message: `Claude Code 사용자 설정의 statusLine 만 바꿉니다 (기존 상태 표시줄 명령은 그대로 두고 dotbugi 줄만 더하거나 뺍니다). 다른 설정은 그대로 두되 파일은 2칸 들여쓰기 JSON 으로 다시 씁니다.`,
    targets,
    // 토큰을 파일의 현재 내용·바꿀 결과에 묶는다 — 그사이 파일이 바뀌면 토큰이 맞지 않는다
    binding: [file, raw ?? '', out],
    token: confirmToken,
  });
  if (!confirmed.ok) return confirmed.text;
  // 승인을 기다리는 몇 분 사이 Claude Code 등이 파일을 고쳤으면 덮어쓰지 않는다
  if ((await readRaw(file)) !== raw)
    return `승인하는 사이 ${file} 이 바뀌어 아무것도 바꾸지 않았습니다. 다시 호출하세요.`;

  // 심볼릭 링크(dotfiles 관리 등)면 링크를 일반 파일로 바꾸지 않게 실제 파일 자리에 쓴다
  const target = raw === null ? file : await realpath(file);
  const mode = raw === null ? undefined : (await stat(target)).mode & 0o777;
  await mkdir(dirname(target), { recursive: true });
  const tmp = `${target}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(tmp, out, { mode: mode ?? 0o600 });
  if (mode !== undefined) await chmod(tmp, mode);
  try {
    await replaceFile(tmp, target);
  } catch (err) {
    // 설정 전체 복사본을 남기지 않는다
    await rm(tmp, { force: true });
    throw err;
  }

  if (action === 'disable') return `상태 표시줄을 해제했습니다 (${file}).`;
  return [
    `상태 표시줄을 설정했습니다 (${file}). Claude Code 아래쪽에 동영상 강의 STT 진행률이 한 줄로 보입니다 (기존 상태 표시줄은 그 위에 그대로).`,
    'Claude Desktop 앱에는 상태 표시줄이 없습니다 (Claude Code 전용).',
    ...(/[\\/]_npx[\\/]/.test(command)
      ? [
          'npx 캐시 경로라 캐시가 지워지면 표시줄이 사라집니다. 전역 설치(npm i -g @dotbugi/mcp) 후 다시 설정하길 권장합니다.',
        ]
      : []),
  ].join('\n');
}

export function registerSetupStatusline(server: McpServer): void {
  server.registerTool(
    'setup_statusline',
    {
      title: 'Claude Code 상태 표시줄 설정',
      description:
        'Claude Code 사용자 설정(~/.claude/settings.json)의 statusLine 에 동영상 강의 STT 진행 표시(몇 번째/전체·진행률)를 넣거나(enable) 뺀다(disable). ' +
        '이미 쓰는 상태 표시줄이 있으면 지우지 않고 그 아래 줄에 더한다 (진행률이 보이게 refreshInterval 은 2초 이하로). 사용자가 확인 창에서 승인해야 바꾸고, statusLine 외 설정은 건드리지 않는다. disable 은 dotbugi 가 넣은 줄만 빼고 원래 상태 표시줄로 되돌린다. ' +
        'Claude Desktop 에는 상태 표시줄이 없다. 확인 창이 없는 클라이언트면 confirmToken 을 돌려준다 — 사용자 동의를 받은 뒤에만 그 토큰으로 다시 호출한다.',
      inputSchema: z.object({
        action: z.enum(['enable', 'disable']).default('enable').describe('enable: 설정, disable: 해제'),
        confirmToken: confirmTokenInput,
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    async ({ action, confirmToken }, ctx) => {
      try {
        return { content: [{ type: 'text', text: await setupStatusline(askerOf(server, ctx), action, confirmToken) }] };
      } catch (err) {
        return {
          content: [{ type: 'text', text: redact(err instanceof Error ? err.message : String(err)) }],
          isError: true,
        };
      }
    }
  );
}
