import { chmod, mkdir, readFile, realpath, rename, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { randomUUID } from 'node:crypto';
import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
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

// 우리가 넣은 것(또는 문서대로 손으로 넣은 dotbugi-mcp statusline)만 우리 것으로 본다
export const isOurStatusLine = (v: unknown): boolean => {
  const cmd = (v as { command?: unknown } | null)?.command;
  return typeof cmd === 'string' && /dotbugi-mcp|@dotbugi[\\/]mcp/.test(cmd) && /\sstatusline$/.test(cmd.trim());
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
  if (action === 'enable') {
    const desired = { type: 'command', command, refreshInterval: 30 };
    if (isDeepStrictEqual(old, desired)) return `이미 설정돼 있습니다 (${file}).`;
    next.statusLine = desired;
  } else {
    if (old === undefined) return `${file} 에 설정된 상태 표시줄이 없습니다.`;
    if (!isOurStatusLine(old))
      return `${file} 의 상태 표시줄은 dotbugi 가 넣은 것이 아니라 지우지 않았습니다: ${JSON.stringify(old)}`;
    delete next.statusLine;
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
    message: `Claude Code 사용자 설정의 statusLine 만 바꿉니다. 다른 설정은 그대로 두되 파일은 2칸 들여쓰기 JSON 으로 다시 씁니다.`,
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
  await rename(tmp, target);

  if (action === 'disable') return `상태 표시줄을 해제했습니다 (${file}).`;
  return [
    `상태 표시줄을 설정했습니다 (${file}). Claude Code 에서 VOD 연속 재생 중 진행 상황이 아래쪽에 한 줄로 보입니다.`,
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
        'Claude Code 사용자 설정(~/.claude/settings.json)의 statusLine 에 VOD 재생 진행 표시를 넣거나(enable) 뺀다(disable). ' +
        '사용자가 확인 창에서 승인해야 바꾸고, statusLine 외 설정은 건드리지 않는다. disable 은 dotbugi 가 넣은 것만 지운다. ' +
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
