#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { log } from './log.js';

const USAGE = `사용법:
  dotbugi-mcp                  MCP 서버 실행 (stdio)
  dotbugi-mcp login            dotbugi 확장으로 LMS 세션 연결
  dotbugi-mcp login --browser  임시 브라우저 창에서 직접 로그인
  dotbugi-mcp logout           저장된 세션 삭제
  dotbugi-mcp play             미출석 VOD 를 마감 임박 순으로 공식 플레이어 창에 차례로 열기 (Ctrl+C 로 중지)
  dotbugi-mcp sync             강의자료를 ~/Downloads/dotbugi-mcp/<과목>/<N주차>/ 에 받기 (LMS 에서 사라진 파일은 하나씩 삭제 여부 확인)
  dotbugi-mcp transcribe <cmid>  VOD 하나를 로컬 ASR 로 받아써 강의자료 주차 폴더에 녹취-<강의명>.md 로 저장 (Ctrl+C 로 중지)
  dotbugi-mcp courses          list_tasks·play·sync 등이 다룰 강좌 켜기/끄기 (터미널에서 ↑↓·Space·Enter)
  dotbugi-mcp courses --list | --on <과목명|courseId> | --off <과목명|courseId>
  dotbugi-mcp statusline       VOD 재생 상태 한 줄 출력 (Claude Code 상태 표시줄용)
  dotbugi-mcp asr install [--gpu] [--model 0.6b|1.7b] | status | remove [--yes]
                               로컬 음성 인식(Qwen3-ASR) 런타임 관리 (~/.cache/dotbugi-mcp/asr)`;

async function main(): Promise<void> {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      browser: { type: 'boolean' },
      worker: { type: 'boolean' },
      gpu: { type: 'boolean' },
      model: { type: 'string' },
      yes: { type: 'boolean' },
      list: { type: 'boolean' },
      on: { type: 'string' },
      off: { type: 'string' },
    },
  });
  const [command, ...rest] = positionals;
  const asrOnly = values.gpu || values.model !== undefined || values.yes;
  const coursesOnly = values.list || values.on !== undefined || values.off !== undefined;
  // --worker 는 transcribe_vod 도구가 띄우는 백그라운드 작업용 (출력 없음)
  if (
    rest.length !== (command === 'transcribe' || command === 'asr' ? 1 : 0) ||
    (values.browser && command !== 'login') ||
    (values.worker && command !== 'transcribe') ||
    (asrOnly && command !== 'asr') ||
    (coursesOnly && command !== 'courses')
  )
    throw new Error(USAGE);
  // stdout 은 MCP 프로토콜 전용 — 로그는 반드시 stderr 로
  // 명령별로 필요한 모듈만 불러온다 — 자주 실행되는 statusline 이 MCP SDK·키체인 모듈 로딩을 기다리지 않게
  if (command === undefined) {
    const [{ serveStdio }, { createServer }] = await Promise.all([
      import('@modelcontextprotocol/server/stdio'),
      import('./server.js'),
    ]);
    return void serveStdio(createServer);
  }
  if (command === 'login') return (await import('./commands/login.js')).login(values.browser ? 'browser' : 'extension');
  if (command === 'logout') return (await import('./commands/logout.js')).logout();
  if (command === 'play') return (await import('./commands/play.js')).play();
  if (command === 'sync') return (await import('./commands/sync.js')).sync();
  if (command === 'transcribe')
    return (await import('./commands/transcribe.js')).transcribe(rest[0], values.worker === true);
  if (command === 'courses')
    return (await import('./commands/courses.js')).courses({ list: values.list, on: values.on, off: values.off });
  if (command === 'statusline') return (await import('./commands/statusline.js')).statusline();
  if (command === 'asr')
    return (await import('./commands/asr.js')).asr(rest, { gpu: values.gpu, model: values.model, yes: values.yes });
  throw new Error(USAGE);
}

main().catch((err: unknown) => {
  log(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
