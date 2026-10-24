import { afterEach, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

const registered = async () => {
  const { registerShortcuts } = await import('../prompts/shortcuts.js');
  const prompts = new Map<string, () => { messages: { content: { text: string } }[] }>();
  registerShortcuts({ registerPrompt: (name: string, _m: unknown, cb: never) => prompts.set(name, cb) } as never);
  return prompts;
};

// 플러그인은 같은 명령을 플러그인 스킬 /dotbugi:<name> 로 주므로, / 메뉴에 두 벌 보이지 않게 프롬프트는 등록하지 않는다
it('플러그인으로 띄우면 바로가기 프롬프트를 등록하지 않는다', async () => {
  vi.stubEnv('CLAUDE_PLUGIN_ROOT', '/p');
  expect((await registered()).size).toBe(0);
});

it('claude mcp add 로 띄우면 프롬프트를 등록하고 안내는 /dotbugi: 로 한다', async () => {
  vi.stubEnv('CLAUDE_PLUGIN_ROOT', '');
  const help = (await registered()).get('help')!().messages[0].content.text;
  expect(help).toContain('`/dotbugi:status [과목\\|courseId] [past]`');
  expect(help).not.toContain('mcp__');
});
