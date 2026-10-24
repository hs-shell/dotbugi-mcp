import { atom, read, update } from 'claude-code';
import type { EngineInterface, Register } from 'claude-code';

import type { BandLine } from '../types';
import { formatBand } from './format';

const line = atom({ plugin: 'dotbugi', key: 'line' } as const, null as BandLine | null);

const TONE_COLORS = { running: 'suggestion', done: 'success', error: 'error', stopped: 'inactive' } as const;

// 서버(src/player/state.ts)와 같은 자리: os.homedir()/.cache/dotbugi-mcp (XDG_CACHE_HOME 은 따르지 않는다)
const cacheDir = async ($: EngineInterface) => {
  const home = (await $.env.get('HOME')) ?? (await $.env.get('USERPROFILE'));
  return home ? `${home}/.cache/dotbugi-mcp` : null;
};

// 없거나 깨진 파일은 null — 모양 확인은 formatBand 가 한다
const readJson = ($: EngineInterface, file: string) =>
  $.fs
    .read(file)
    .then((text) => JSON.parse(text) as unknown)
    .catch(() => null);

export const register: Register = (on) => {
  // 입력이 없어도 진행률이 움직이게 1초마다 상태 파일을 읽는다. 같은 줄이면 쓰지 않아 다시 그리지 않는다
  on('session.start', async ($, e, next) => {
    const dir = await cacheDir($);
    if (dir) {
      $.clock.every(1000, async () => {
        const [state, queue] = await Promise.all([
          readJson($, `${dir}/transcribe-state.json`),
          readJson($, `${dir}/transcribe-queue.json`),
        ]);
        const fresh = formatBand(state, queue, await $.clock.now());
        const prev = await read($, line);
        if (prev?.text !== fresh?.text || prev?.tone !== fresh?.tone) await update($, line, () => fresh);
      });
    }
    return next(e);
  });

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const mine = e.props.hasSurvey ? null : await read($, line);
    if (!mine) return next(e);
    // 다른 mod(예: ponytail)의 band 도 함께 그린다. 아래에 아무도 없으면(테스트 등) reject
    const below = await next(e).catch(() => undefined);
    const { Box, Text } = $.ui.resolve(e);
    // LMS 글이 섞인 줄이라 Text 로만, 폭을 넘으면 끝을 자른다
    const row = (
      <Text color={TONE_COLORS[mine.tone]} wrap="truncate-end">
        {mine.text}
      </Text>
    );
    return below ? (
      <Box flexDirection="column">
        {row}
        {below}
      </Box>
    ) : (
      row
    );
  }).catch(($, e, next) => next(e));
};
