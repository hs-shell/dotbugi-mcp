import { expect, mock, test } from 'claude-code/testing';

const NOW = Date.parse('2026-10-25T00:00:30.000Z');
const FILES: Record<string, string> = {
  '/h/.cache/dotbugi-mcp/transcribe-state.json': JSON.stringify({
    status: 'running',
    phase: 'transcribe',
    progress: 42,
    course: '데이터베이스',
    title: '3주차',
    updatedAt: '2026-10-25T00:00:00.000Z',
  }),
  '/h/.cache/dotbugi-mcp/transcribe-queue.json': JSON.stringify({ pending: [{}], finished: [{}] }),
};

test('입력창 위에 STT 진행 한 줄을 그린다', async ($, on) => {
  const clock = mock.clock(on, { now: NOW });
  mock.env(on, { HOME: '/h' });
  on('fs.read', async (_$, e) => {
    const text = FILES[e.path];
    return text === undefined ? { deny: 'ENOENT' } : { value: text };
  });
  on('session.start', (_$, e) => ({ cwd: e.cwd }));
  // 다른 mod 의 band 자리 — 지우지 않고 함께 그려야 한다
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Text } = $.ui.resolve(e);
    return h(Text, {}, 'other');
  });
  await $.session.start({ cwd: '/w', surface: 'terminal', isInteractive: true });
  await clock.advance(1000);
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({
      plugin: 'dotbugi',
      surface,
      component: 'AbovePrompt',
      props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 80 },
    });
    expect((await ui.find({ type: 'Text', text: /STT/ }))?.text).toBe('STT 2/3 ▸ 데이터베이스 3주차 ▓▓▓░░░░░ 42%');
    expect((await ui.find({ type: 'Text', text: /other/ }))?.text).toBe('other');
    await ui.unmount();
  }
});
