import { afterEach, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

// 플러그인이 띄운 서버는 이름이 plugin:dotbugi:dotbugi 라 안내하는 명령도 그 이름을 따라야 한다
it('플러그인으로 띄우면 명령 안내가 /mcp__plugin_dotbugi_dotbugi__ 로 바뀐다', async () => {
  vi.stubEnv('CLAUDE_PLUGIN_ROOT', '/p');
  const { registerShortcuts } = await import('../prompts/shortcuts.js');
  const prompts = new Map<string, () => { messages: { content: { text: string } }[] }>();
  registerShortcuts({ registerPrompt: (name: string, _m: unknown, cb: never) => prompts.set(name, cb) } as never);
  const help = prompts.get('help')!().messages[0].content.text;
  expect(help).toContain('`/mcp__plugin_dotbugi_dotbugi__status [과목\\|courseId] [past]`');
  expect(help).not.toContain('/dotbugi:');
});
