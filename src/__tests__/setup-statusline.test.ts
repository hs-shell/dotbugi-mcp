import { existsSync } from 'node:fs';
import { chmod, mkdtemp, readdir, readFile, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// rename 실패를 흉내 내려고 감싼다 (평소에는 원래 함수 그대로)
vi.mock('node:fs/promises', async (orig) => {
  const fs = await orig<typeof import('node:fs/promises')>();
  return { ...fs, rename: vi.fn(fs.rename) };
});
import type { Asker } from '../tools/confirm.js';
import { isOurStatusLine, setupStatusline, statusLineCommand, userSettingsFile } from '../tools/setup-statusline.js';

let dir: string;
const file = () => join(dir, 'settings.json');
const CMD = statusLineCommand('/usr/bin/node', '/opt/my apps/@dotbugi/mcp/dist/index.js', 'linux');
const approve = (): Asker => ({
  caps: { elicitation: { form: {} } },
  elicit: vi.fn(async () => ({ action: 'accept' as const, content: { confirm: true } })),
});
const decline: Asker = { caps: { elicitation: { form: {} } }, elicit: async () => ({ action: 'decline' }) };
const run = (asker: Asker, action: 'enable' | 'disable' = 'enable', token?: string) =>
  setupStatusline(asker, action, token, file(), CMD);
const read = async () => JSON.parse(await readFile(file(), 'utf8')) as Record<string, unknown>;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'dotbugi-statusline-'));
});
afterEach(() => rm(dir, { recursive: true, force: true }));

describe('statusLineCommand', () => {
  it('node 와 진입점을 절대 경로로, 셸이 해석하지 않게 따옴표로 감싼다', () => {
    expect(CMD).toBe(`'/usr/bin/node' '/opt/my apps/@dotbugi/mcp/dist/index.js' statusline`);
    expect(statusLineCommand("/a/it's/node", '/b/index.js', 'linux')).toBe(
      `'/a/it'\\''s/node' '/b/index.js' statusline`
    );
    expect(statusLineCommand('C:\\Program Files\\nodejs\\node.exe', 'C:\\x\\index.js', 'win32')).toBe(
      '"C:/Program Files/nodejs/node.exe" "C:/x/index.js" statusline'
    );
    expect(() => statusLineCommand('C:\\$x\\node.exe', 'C:\\i.js', 'win32')).toThrow();
    expect(isOurStatusLine({ command: CMD })).toBe(true);
    expect(isOurStatusLine({ command: 'dotbugi-mcp statusline' })).toBe(true);
    expect(isOurStatusLine({ command: '~/.claude/statusline.sh' })).toBe(false);
  });

  it('CLAUDE_CONFIG_DIR 이 있으면 그 아래 settings.json', () => {
    vi.stubEnv('CLAUDE_CONFIG_DIR', '/cfg');
    expect(userSettingsFile()).toBe(join('/cfg', 'settings.json'));
    vi.unstubAllEnvs();
  });
});

describe('setup_statusline', () => {
  it('파일이 없으면 승인 후 만든다', async () => {
    const asker = approve();
    expect(await run(asker)).toContain('설정했습니다');
    expect(await read()).toEqual({
      statusLine: { type: 'command', command: `${CMD} --refresh-was=none`, refreshInterval: 2 },
    });
    // 같은 값이면 다시 묻지 않는다
    expect(await run(asker)).toContain('이미 설정');
    expect(asker.elicit).toHaveBeenCalledTimes(1);
  });

  it('다른 키는 순서·값 그대로 두고, 기존 statusLine 은 살려 합치며 바꾸기 전 승인 창에 보여준다', async () => {
    await writeFile(
      file(),
      JSON.stringify({ model: 'opus', statusLine: { type: 'command', command: 'mine.sh' }, z: [1] })
    );
    await chmod(file(), 0o640);
    const asker = approve();
    await run(asker);
    const shown = vi.mocked(asker.elicit).mock.calls[0]![0].message;
    expect(shown).toContain('mine.sh');
    expect(shown).toContain(JSON.stringify(`mine.sh\n${CMD} --refresh-was=none`));
    const after = await read();
    expect(Object.keys(after)).toEqual(['model', 'statusLine', 'z']);
    // 기존 명령은 지우지 않고 다음 줄에 붙인다
    expect(after).toMatchObject({
      model: 'opus',
      z: [1],
      statusLine: { command: `mine.sh\n${CMD} --refresh-was=none`, refreshInterval: 2 },
    });
    if (process.platform !== 'win32') expect((await stat(file())).mode & 0o777).toBe(0o640);
  });

  it('JSON 이 아니면(주석 포함) 묻지도 바꾸지도 않는다', async () => {
    const text = '{\n  // 내 설정\n  "model": "opus"\n}\n';
    await writeFile(file(), text);
    const asker = approve();
    expect(await run(asker)).toContain('올바른 JSON 이 아니라');
    expect(asker.elicit).not.toHaveBeenCalled();
    expect(await readFile(file(), 'utf8')).toBe(text);
  });

  it('승인하지 않으면 그대로 둔다', async () => {
    await writeFile(file(), '{"model":"opus"}');
    expect(await run(decline)).toContain('승인하지 않아 아무것도 바꾸지 않았습니다');
    expect(await readFile(file(), 'utf8')).toBe('{"model":"opus"}');
  });

  it('승인을 기다리는 사이 파일이 바뀌면 덮어쓰지 않는다', async () => {
    await writeFile(file(), '{}');
    const asker: Asker = {
      caps: { elicitation: { form: {} } },
      elicit: async () => {
        await writeFile(file(), '{"model":"new"}');
        return { action: 'accept', content: { confirm: true } };
      },
    };
    expect(await run(asker)).toContain('바뀌어');
    expect(await read()).toEqual({ model: 'new' });
  });

  it('확인 창이 없으면 토큰을 받은 두 번째 호출에서만 쓴다', async () => {
    const asker: Asker = { caps: {}, elicit: async () => ({ action: 'accept' }) };
    const first = await run(asker);
    expect(existsSync(file())).toBe(false);
    await run(asker, 'enable', /confirmToken: "([0-9a-f]+)"/.exec(first)![1]);
    expect(await read()).toMatchObject({ statusLine: { command: `${CMD} --refresh-was=none` } });
  });

  it('심볼릭 링크면 링크를 살리고 실제 파일에 쓴다', async () => {
    const real = join(dir, 'real.json');
    await writeFile(real, '{}');
    await symlink(real, file());
    await run(approve());
    expect(JSON.parse(await readFile(real, 'utf8'))).toMatchObject({
      statusLine: { command: `${CMD} --refresh-was=none` },
    });
  });

  it('disable 은 dotbugi 줄만 빼고 사용자 명령·다른 값은 되돌리며, dotbugi 줄이 없으면 거절한다', async () => {
    await writeFile(file(), JSON.stringify({ model: 'opus', statusLine: { type: 'command', command: 'mine.sh' } }));
    const asker = approve();
    expect(await run(asker, 'disable')).toContain('dotbugi 가 넣은 줄이 없어');
    expect(asker.elicit).not.toHaveBeenCalled();
    expect(await read()).toMatchObject({ statusLine: { command: 'mine.sh' } });

    await run(asker);
    expect(await run(asker, 'disable')).toContain('해제했습니다');
    // enable 이 넣은 refreshInterval 까지 빼서 원래 객체 그대로
    expect(await read()).toEqual({ model: 'opus', statusLine: { type: 'command', command: 'mine.sh' } });

    await writeFile(file(), JSON.stringify({ model: 'opus', statusLine: { type: 'command', command: CMD } }));
    expect(await run(asker, 'disable')).toContain('해제했습니다');
    expect(await read()).toEqual({ model: 'opus' });
    expect(await run(asker, 'disable')).toContain('없습니다');
  });

  it('padding 은 그대로 두고, 다시 켜면 dotbugi 줄만 바꾼다', async () => {
    const OLD = statusLineCommand('/old/node', '/old/dotbugi-mcp/dist/index.js', 'linux');
    await writeFile(
      file(),
      JSON.stringify({
        statusLine: { type: 'command', command: `bash a.sh # 주석\n${OLD}`, padding: 0, refreshInterval: 5 },
      })
    );
    await run(approve());
    expect(await read()).toEqual({
      statusLine: {
        type: 'command',
        command: `bash a.sh # 주석\n${CMD} --refresh-was=5`,
        padding: 0,
        refreshInterval: 2,
      },
    });
  });

  it('refreshInterval 이 2초보다 길면 2초로 낮추고 disable 은 원래 값으로 되돌린다', async () => {
    const orig = { type: 'command', command: 'bash ~/.claude/statusline.sh', padding: 0, refreshInterval: 10 };
    await writeFile(file(), JSON.stringify({ statusLine: orig }));
    const asker = approve();
    await run(asker);
    expect(await read()).toEqual({
      statusLine: { ...orig, command: `${orig.command}\n${CMD} --refresh-was=10`, refreshInterval: 2 },
    });
    // 다시 켜도 기록한 원래 값을 잃지 않는다
    expect(await run(asker)).toContain('이미 설정');
    await run(asker, 'disable');
    expect(await read()).toEqual({ statusLine: orig });
  });

  it('지수 표기가 되는 큰 refreshInterval 은 건드리지 않아 다시 켜도 줄이 겹치지 않는다', async () => {
    await writeFile(
      file(),
      JSON.stringify({ statusLine: { type: 'command', command: 'a.sh', refreshInterval: 1e21 } })
    );
    const asker = approve();
    await run(asker);
    expect(await read()).toEqual({ statusLine: { type: 'command', command: `a.sh\n${CMD}`, refreshInterval: 1e21 } });
    expect(await run(asker)).toContain('이미 설정');
  });

  it('command 형식이 아닌 statusLine 은 묻지도 바꾸지도 않는다', async () => {
    await writeFile(file(), JSON.stringify({ statusLine: { type: 'static', text: 'x' } }));
    const asker = approve();
    expect(await run(asker)).toContain('형식을 알 수 없어');
    expect(asker.elicit).not.toHaveBeenCalled();
  });

  it('패키지 이름이 없는 경로라도 enable 이 쓴 명령이면 disable 로 지운다', async () => {
    const plain = statusLineCommand('/usr/bin/node', '/home/me/src/mcp/dist/index.js', 'linux');
    const asker = approve();
    await setupStatusline(asker, 'enable', undefined, file(), plain);
    expect(await setupStatusline(asker, 'disable', undefined, file(), plain)).toContain('해제했습니다');
    expect(await read()).toEqual({});
  });

  it('바꿔치기에 실패하면 임시 파일을 지우고 원본은 그대로 둔다', async () => {
    await writeFile(file(), '{"model":"opus"}');
    vi.mocked(rename).mockRejectedValueOnce(new Error('EPERM'));
    await expect(run(approve())).rejects.toThrow('EPERM');
    expect(await readdir(dir)).toEqual(['settings.json']);
    expect(await readFile(file(), 'utf8')).toBe('{"model":"opus"}');
  });
});
