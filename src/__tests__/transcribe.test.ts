import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import type { spawn } from 'node:child_process';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DOMParser } from 'linkedom';
import type { FetchHtml } from '@dotbugi/lms-parser';
import { SessionExpiredError } from '../lms.js';
import { acquireLock, adoptLock } from '../player/lock.js';
import { findVod } from '../transcribe/find-vod.js';
import { extractPlaylistUrl, mediaGet, parsePlaylist } from '../transcribe/hls.js';
import { transcribeVod, type TranscribeDeps } from '../transcribe/pipeline.js';
import {
  readTranscribeState,
  TRANSCRIBE_LOCK_FILE,
  TRANSCRIBE_STATE_FILE,
  TRANSCRIBE_STATE_STALE_MS,
  writeTranscribeState,
  type TranscribeState,
} from '../transcribe/state.js';
import { startWorker, stopTranscribe, transcribeStatusState } from '../tools/transcribe-vod.js';
import { PAGES } from './fixtures/lms-pages.js';

// 상태·잠금 경로는 import 시점에 homedir 로 정해진다 — 그 전에 테스트 전용 홈을 정한다
const state = vi.hoisted(() => ({ home: `${process.env.TMPDIR ?? '/tmp'}/dotbugi-transcribe-home-${process.pid}` }));
vi.mock('node:os', async (orig) => ({ ...(await orig<typeof import('node:os')>()), homedir: () => state.home }));

const HOST = 'abc123.edge.naverncp.com';
const TOKEN = 'SECRETTOKEN0123';
const PLAYLIST = `https://${HOST}/hls/${TOKEN}/uuid/mp4/uuid.mp4/index.m3u8`;
const viewer = (file: string) =>
  `<script>jwplayer('p').setup({ sources: [{file: '${file}'}], width: '100%' });</script>`;
const media = (segments: string[], extra = '') =>
  [
    '#EXTM3U',
    '#EXT-X-TARGETDURATION:10',
    extra,
    ...segments.flatMap((s) => ['#EXTINF:10.0,', s]),
    '#EXT-X-ENDLIST',
  ].join('\n');

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'transcribe-'));
});
afterEach(() => rm(dir, { recursive: true, force: true }));
afterAll(() => rm(state.home, { recursive: true, force: true }));

describe('extractPlaylistUrl', () => {
  it('JW Player 설정의 CDN m3u8 을 꺼낸다', () => {
    expect(extractPlaylistUrl(viewer(PLAYLIST)).href).toBe(PLAYLIST);
  });

  it.each([
    `http://${HOST}/hls/x/index.m3u8`,
    `https://${HOST}.evil.com/hls/x/index.m3u8`,
    'https://edge.naverncp.com.evil.com/x.m3u8',
    'https://evil.com/x.m3u8',
    `https://${HOST}@evil.com/x.m3u8`,
    `https://${HOST}:8443/x.m3u8`,
    `https://a.b.edge.naverncp.com/x.m3u8`,
  ])('허용되지 않은 주소는 거부한다: %s', (url) => {
    expect(() => extractPlaylistUrl(viewer(url))).toThrow('허용된 영상 주소');
  });

  it('여럿이면 허용된 것만 고른다', () => {
    const html = viewer('https://evil.com/a.m3u8') + viewer(PLAYLIST);
    expect(extractPlaylistUrl(html).hostname).toBe(HOST);
  });
});

describe('parsePlaylist', () => {
  const base = new URL(PLAYLIST);

  it('세그먼트를 재생 목록 기준으로 풀고 길이를 더한다', () => {
    const list = parsePlaylist(media(['segment-1-v1-a1.ts', 'segment-2-v1-a1.ts']), base);
    expect(list.seconds).toBe(20);
    expect(list.segments[1].href).toBe(PLAYLIST.replace('index.m3u8', 'segment-2-v1-a1.ts'));
  });

  it('METHOD=NONE 이 아닌 EXT-X-KEY 는 거부한다', () => {
    expect(() => parsePlaylist(media(['s.ts'], '#EXT-X-KEY:METHOD=AES-128,URI="k"'), base)).toThrow('암호화');
    expect(() => parsePlaylist(media(['s.ts'], '#EXT-X-SESSION-KEY:METHOD=SAMPLE-AES,URI="k"'), base)).toThrow(
      '암호화'
    );
    // METHOD=NONE 은 속성 이름까지 맞아야 한다
    expect(() => parsePlaylist(media(['s.ts'], '#EXT-X-KEY:XMETHOD=NONE,METHOD=AES-128'), base)).toThrow('암호화');
    expect(parsePlaylist(media(['s.ts'], '#EXT-X-KEY:METHOD=NONE'), base).segments).toHaveLength(1);
  });

  it.each(['https://evil.com/s.ts', `http://${HOST}/s.ts`, `//other.edge.naverncp.com/s.ts`])(
    '다른 호스트 세그먼트는 거부한다: %s',
    (seg) => {
      expect(() => parsePlaylist(media([seg]), base)).toThrow('다른 서버');
    }
  );

  it.each(['#EXT-X-STREAM-INF:BANDWIDTH=1', '#EXT-X-MAP:URI="init.mp4"', '#EXT-X-BYTERANGE:100@0'])(
    '이어 붙일 수 없는 형식은 거부한다: %s',
    (tag) => {
      expect(() => parsePlaylist(media(['s.ts'], tag), base)).toThrow('지원하지 않는');
    }
  );

  it('재생 목록이 아니거나 세그먼트가 너무 많으면 거부한다', () => {
    expect(() => parsePlaylist('<html>', base)).toThrow('형식이 아닙니다');
    const many = Array.from({ length: 2161 }, (_, i) => `s${i}.ts`);
    expect(() => parsePlaylist(media(many), base)).toThrow('너무 길어');
  });
});

describe('mediaGet', () => {
  const signal = new AbortController().signal;

  it('쿠키 없이 리다이렉트를 따라가지 않고 요청하며, 리다이렉트 응답은 거부한다', async () => {
    const fetchImpl = vi.fn(
      async () => new Response(null, { status: 302, headers: { location: 'https://evil.com/' } })
    );
    await expect(mediaGet(new URL(PLAYLIST), HOST, 100, signal, fetchImpl)).rejects.toThrow('다른 주소로 이동');
    const init = fetchImpl.mock.calls[0] as unknown as [URL, RequestInit];
    expect(init[1]).toMatchObject({ redirect: 'manual', credentials: 'omit' });
    expect(init[1].headers).toBeUndefined();
  });

  it('고정한 호스트가 아니면 요청하지 않는다', async () => {
    const fetchImpl = vi.fn();
    await expect(
      mediaGet(new URL('https://other.edge.naverncp.com/s.ts'), HOST, 100, signal, fetchImpl)
    ).rejects.toThrow('허용되지 않은');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('받은 바이트가 상한을 넘으면 중단한다', async () => {
    const fetchImpl = async () => new Response(new Uint8Array(101));
    await expect(mediaGet(new URL(PLAYLIST), HOST, 100, signal, fetchImpl)).rejects.toThrow('상한');
  });

  it('연결 오류에 주소를 싣지 않는다', async () => {
    const fetchImpl = async () => {
      throw new TypeError(`fetch failed ${PLAYLIST}`);
    };
    const err = (await mediaGet(new URL(PLAYLIST), HOST, 100, signal, fetchImpl).catch((e) => e)) as Error;
    expect(err.message).not.toContain(TOKEN);
  });
});

// 가짜 ffmpeg·ASR: ffmpeg 는 PCM 을 내고, ASR 은 stdin 을 다 읽은 뒤 글을 낸다
type Child = EventEmitter & { stdout: PassThrough; stdin: PassThrough; stderr: PassThrough };
function fakeSpawn(opts: { asrCode?: number | null; asrSignal?: string; stderr?: string } = {}) {
  const calls: { command: string; args: string[] }[] = [];
  const impl = ((command: string, args: string[]) => {
    calls.push({ command, args });
    const c = Object.assign(new EventEmitter(), {
      stdout: new PassThrough(),
      stdin: new PassThrough(),
      stderr: new PassThrough(),
    }) as Child;
    setImmediate(() => {
      if (command === 'ffmpeg') c.stdout.end(Buffer.alloc(64_000), () => setImmediate(() => c.emit('close', 0, null)));
      else {
        c.stdin.resume();
        c.stdin.on('end', () => {
          if (opts.stderr) c.stderr.write(opts.stderr);
          c.stdout.end('안녕하세요 강의입니다\n', () =>
            setImmediate(() => c.emit('close', opts.asrCode === undefined ? 0 : opts.asrCode, opts.asrSignal ?? null))
          );
        });
      }
    });
    return c;
  }) as unknown as typeof spawn;
  return { impl, calls };
}

const META = { course: '자료구조', courseId: '123', week: '3주차', title: '1강 소개' };

function deps(over: Partial<TranscribeDeps> = {}) {
  const reports: unknown[] = [];
  const fetched: string[] = [];
  const files: Record<string, string | Uint8Array<ArrayBuffer>> = {
    [PLAYLIST]: media(['segment-1-v1-a1.ts', 'segment-2-v1-a1.ts']),
    [PLAYLIST.replace('index.m3u8', 'segment-1-v1-a1.ts')]: new Uint8Array([1, 2]),
    [PLAYLIST.replace('index.m3u8', 'segment-2-v1-a1.ts')]: new Uint8Array([3]),
  };
  const sp = fakeSpawn();
  const runtime = vi.fn(async () => ({
    ffmpeg: 'ffmpeg',
    kind: 'cpu' as const,
    command: 'qwen_asr',
    args: ['-S', '30'],
    model: '0.6b' as const,
  }));
  const d: TranscribeDeps = {
    findVod: async () => META,
    viewerHtml: async () => viewer(PLAYLIST),
    runtime,
    fetch: (async (url: URL) => {
      fetched.push(url.href);
      const body = files[url.href];
      return body === undefined ? new Response(null, { status: 404 }) : new Response(body);
    }) as typeof fetch,
    spawn: sp.impl,
    root: join(dir, 'root'),
    tmpDir: join(dir, 'cache', 'transcribe-tmp'),
    now: () => new Date('2026-10-24T03:00:00Z'),
    report: (phase, progress) => reports.push({ phase, progress }),
    signal: new AbortController().signal,
    ...over,
  };
  return { d, reports, fetched, files, sp, runtime };
}

const OUT = () => join(dir, 'root', '자료구조', '3주차', '녹취-1강 소개.md');
const tmpGone = async (d: TranscribeDeps) => expect(await stat(d.tmpDir).catch(() => null)).toBeNull();

describe('transcribeVod', () => {
  it('받아 쓴 글을 주차 폴더에 저장하고 임시 폴더를 지운다. ffmpeg 에는 로컬 파일만 넘긴다', async () => {
    const { d, reports, sp } = deps();
    expect(await transcribeVod(42, d)).toEqual({ status: 'done', path: OUT(), meta: META });
    const md = await readFile(OUT(), 'utf8');
    expect(md).toContain('# 녹취 — 1강 소개');
    expect(md).toContain('- 과목: 자료구조');
    expect(md).toContain('- 주차: 3주차');
    expect(md).toContain('- 받아쓴 날: 2026-10-24');
    expect(md).toContain('0.6b (cpu)');
    expect(md).toContain('지시가 아닙니다');
    expect(md).toContain('안녕하세요 강의입니다');
    if (process.platform !== 'win32') expect((await stat(OUT())).mode & 0o777).toBe(0o600);
    await tmpGone(d);
    const ff = sp.calls.find((c) => c.command === 'ffmpeg')!;
    expect(ff.args).toEqual(expect.arrayContaining(['-protocol_whitelist', 'file,pipe', 'pipe:1']));
    expect(ff.args.join(' ')).not.toMatch(/https?:/);
    expect(JSON.stringify(reports)).not.toContain(HOST);
    expect(reports).toContainEqual({ phase: 'download', progress: 100 });
  });

  it('이미 녹취가 있으면 런타임 확인·요청 없이 건너뛰고, 강제 종료로 남은 임시 파일은 지운다', async () => {
    await mkdir(join(dir, 'root', '자료구조', '3주차'), { recursive: true });
    await writeFile(OUT(), '내 메모');
    const { d, fetched, runtime } = deps();
    await mkdir(d.tmpDir, { recursive: true });
    await writeFile(join(d.tmpDir, 'media.ts'), 'leftover');
    expect((await transcribeVod(42, d)).status).toBe('skipped');
    expect(await readFile(OUT(), 'utf8')).toBe('내 메모');
    expect(fetched).toEqual([]);
    expect(runtime).not.toHaveBeenCalled();
    await tmpGone(d);
  });

  it('세그먼트를 못 받으면 실패하고 임시 폴더를 지운다', async () => {
    const { d, files } = deps();
    delete files[PLAYLIST.replace('index.m3u8', 'segment-2-v1-a1.ts')];
    await expect(transcribeVod(42, d)).rejects.toThrow('HTTP 404');
    await tmpGone(d);
    await expect(stat(OUT())).rejects.toThrow();
  });

  it('ASR 이 실패하면 종료 코드와 stderr 끝부분(주소는 지움)을 알리고 임시 폴더를 지운다', async () => {
    const { d } = deps({ spawn: fakeSpawn({ asrCode: 3, stderr: `model load failed ${PLAYLIST}` }).impl });
    const err = (await transcribeVod(42, d).catch((e) => e)) as Error;
    expect(err.message).toContain('(3)');
    expect(err.message).toContain('model load failed [URL]');
    expect(err.message).not.toContain(TOKEN);
    await tmpGone(d);
  });

  it('시그널로 끝나면 시그널 이름을 알린다', async () => {
    const { d } = deps({ spawn: fakeSpawn({ asrCode: null, asrSignal: 'SIGKILL' }).impl });
    await expect(transcribeVod(42, d)).rejects.toThrow('(SIGKILL)');
  });

  it('중지 신호를 받으면 받던 중이라도 멈추고 임시 폴더를 지우며 녹취를 남기지 않는다', async () => {
    const ac = new AbortController();
    const base = deps({ signal: ac.signal });
    const fetchImpl = base.d.fetch;
    // 두 번째 세그먼트를 받으려는 순간 중지 신호가 온다
    base.d.fetch = (async (url: URL, init?: RequestInit) => {
      if (url.href.includes('segment-2')) ac.abort();
      init?.signal?.throwIfAborted();
      return fetchImpl(url, init);
    }) as typeof fetch;
    await expect(transcribeVod(42, base.d)).rejects.toThrow();
    await tmpGone(base.d);
    await expect(stat(OUT())).rejects.toThrow();
  });

  it('ASR 런타임이 없으면 아무것도 받지 않는다', async () => {
    const { d, fetched } = deps({ runtime: () => Promise.reject(new Error('ASR 런타임이 설치되지 않았습니다')) });
    await expect(transcribeVod(42, d)).rejects.toThrow('설치되지 않았습니다');
    expect(fetched).toEqual([]);
  });
});

describe('findVod', () => {
  const fetchHtml = (override: Record<string, () => never> = {}): FetchHtml =>
    (async (url: string) => {
      override[url]?.();
      const html = PAGES[new URL(url, 'https://learn.hansung.ac.kr').href] ?? '';
      return new DOMParser().parseFromString(`<html><body>${html}</body></html>`, 'text/html') as unknown as Document;
    }) as FetchHtml;

  it('출석 정보와 무관하게 강좌 화면의 VOD 를 cmid 로 찾고, 주차 폴더는 sync_materials 규칙을 따른다', async () => {
    expect(await findVod(fetchHtml(), 2)).toEqual({
      course: '자료구조',
      courseId: '100',
      week: '8주차',
      title: '다음 주 강의',
    });
  });

  it('없으면 오류, 세션 만료는 그대로 올린다', async () => {
    await expect(findVod(fetchHtml(), 999)).rejects.toThrow('찾지 못했습니다');
    const expired = fetchHtml({
      'https://learn.hansung.ac.kr/course/view.php?id=100': () => {
        throw new SessionExpiredError();
      },
    });
    await expect(findVod(expired, 1)).rejects.toBeInstanceOf(SessionExpiredError);
  });
});

describe('상태 파일·작업 잠금', () => {
  it('메시지에 섞인 주소는 지우고 경로는 자르지 않으며 0600 으로 쓴다', async () => {
    const file = join(dir, 'cache', 'transcribe-state.json');
    const longPath = `/home/u/Downloads/dotbugi-mcp/${'과목'.repeat(80)}/3주차/녹취.md`;
    await writeTranscribeState(
      {
        version: 1,
        status: 'error',
        cmid: 42,
        phase: null,
        progress: null,
        course: '자료구조',
        title: '1강',
        path: longPath,
        pid: process.pid,
        updatedAt: new Date().toISOString(),
        message: `실패: ${PLAYLIST}`,
      },
      file
    );
    const raw = await readFile(file, 'utf8');
    expect(raw).not.toContain(TOKEN);
    expect(raw).not.toContain(HOST);
    const read = readTranscribeState(file);
    expect(read?.message).toBe('실패: [URL]');
    expect(read?.path).toBe(longPath);
    if (process.platform !== 'win32') expect((await stat(file)).mode & 0o777).toBe(0o600);
  });

  // 작업 프로세스 pid 로는 살아 있는 이 테스트 프로세스를 쓴다
  const workerDeps = (over: Partial<Parameters<typeof startWorker>[1]> = {}) => {
    const spawnImpl = vi.fn(() => {
      const c = Object.assign(new EventEmitter(), { unref: vi.fn(), pid: process.pid });
      setImmediate(() => c.emit('spawn'));
      return c;
    });
    return {
      spawn: spawnImpl as unknown as typeof spawn,
      getSession: vi.fn(async () => ({ session: 's', savedAt: '', method: 'extension' as const })),
      runtime: vi.fn(async () => ({
        ffmpeg: 'f',
        kind: 'cpu' as const,
        command: 'a',
        args: [],
        model: '0.6b' as const,
      })),
      ...over,
    };
  };

  it('세션·ASR 설치를 먼저 확인하고, 실패하면 띄우지 않는다', async () => {
    const noSession = workerDeps({ getSession: vi.fn(() => Promise.reject(new Error('저장된 LMS 세션이 없습니다'))) });
    await expect(startWorker(42, noSession)).rejects.toThrow('세션이 없습니다');
    const noAsr = workerDeps({ runtime: vi.fn(() => Promise.reject(new Error('ASR 런타임이 설치되지 않았습니다'))) });
    await expect(startWorker(42, noAsr)).rejects.toThrow('설치되지 않았습니다');
    expect(noSession.spawn).not.toHaveBeenCalled();
    expect(noAsr.spawn).not.toHaveBeenCalled();
    await expect(stat(TRANSCRIBE_LOCK_FILE)).rejects.toThrow();
  });

  it('동시에 불러도 하나만 띄우고, 잠금을 작업 프로세스 pid 로 넘긴다', async () => {
    expect(TRANSCRIBE_LOCK_FILE.startsWith(state.home)).toBe(true);
    const d = workerDeps();
    const results = await Promise.allSettled([startWorker(42, d), startWorker(43, d)]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.find((r) => r.status === 'rejected')).toMatchObject({
      reason: expect.objectContaining({ message: expect.stringContaining('이미 받아쓰기가 실행 중') }),
    });
    expect(d.spawn).toHaveBeenCalledTimes(1);
    expect(d.spawn).toHaveBeenCalledWith(
      process.execPath,
      [expect.stringMatching(/index\.js$/), 'transcribe', '--worker', expect.stringMatching(/^4[23]$/)],
      { detached: true, stdio: 'ignore' }
    );
    // 작업 프로세스가 잠금을 이어받고, 끝나면 푼다
    const release = await adoptLock(TRANSCRIBE_LOCK_FILE, 100);
    await release();
    await expect(stat(TRANSCRIBE_LOCK_FILE)).rejects.toThrow();
  });

  it('넘겨받을 잠금이 없거나 다른 프로세스 것이면 이어받지 않는다', async () => {
    await expect(adoptLock(TRANSCRIBE_LOCK_FILE, 100)).rejects.toThrow('넘겨받을');
    const release = await acquireLock(TRANSCRIBE_LOCK_FILE);
    await writeFile(TRANSCRIBE_LOCK_FILE, '1');
    await expect(adoptLock(TRANSCRIBE_LOCK_FILE, 100)).rejects.toThrow('넘겨받을');
    await release();
  });
});

describe('stopTranscribe', () => {
  const OTHER = 424242;
  afterEach(async () => {
    await rm(TRANSCRIBE_LOCK_FILE, { force: true });
    await rm(TRANSCRIBE_STATE_FILE, { force: true });
  });
  const deps = (alive = true) => ({
    // 신호를 받은 작업 프로세스가 잠금을 푸는 것을 흉내 낸다
    kill: vi.fn(() => void rm(TRANSCRIBE_LOCK_FILE, { force: true })),
    isAlive: vi.fn(() => alive),
    timeoutMs: 1000,
  });
  const running = (over: Partial<TranscribeState> = {}): TranscribeState => ({
    version: 1,
    status: 'running',
    cmid: 42,
    phase: 'download',
    progress: 10,
    course: null,
    title: null,
    path: null,
    pid: OTHER,
    updatedAt: new Date().toISOString(),
    message: null,
    ...over,
  });
  const lockWith = async (pid: number | string, state: TranscribeState | null = running()) => {
    if (state) await writeTranscribeState(state);
    await writeFile(TRANSCRIBE_LOCK_FILE, String(pid));
  };

  it('잠금이 없거나 죽은 pid 면 실행 중이 아니라고 답한다', async () => {
    const d = deps(false);
    await expect(stopTranscribe(d)).resolves.toContain('실행 중인 받아쓰기가 없습니다');
    await lockWith(OTHER);
    await expect(stopTranscribe(d)).resolves.toContain('없습니다');
    expect(d.kill).not.toHaveBeenCalled();
  });

  it('살아 있고 상태 파일 pid 와 맞으면 SIGTERM 을 보내고 잠금 해제를 기다린다', async () => {
    const d = deps();
    await lockWith(OTHER);
    await expect(stopTranscribe(d)).resolves.toContain('중지했습니다');
    expect(d.kill).toHaveBeenCalledExactlyOnceWith(OTHER, 'SIGTERM');
  });

  it.each([
    ['내 pid', process.pid, running({ pid: process.pid })],
    ['상태 pid 불일치(재사용 의심)', OTHER, running({ pid: OTHER + 1 })],
    ['상태 파일 없음', OTHER, null],
    ['0', '0', running()],
    ['음수', '-1', running()],
    ['숫자 아님', 'abc', running()],
    ['실행 중이 아님', OTHER, running({ status: 'stopped' })],
    [
      '갱신이 끊김',
      OTHER,
      running({ updatedAt: new Date(Date.now() - TRANSCRIBE_STATE_STALE_MS - 1000).toISOString() }),
    ],
    ['미래 시각', OTHER, running({ updatedAt: new Date(Date.now() + 60_000).toISOString() })],
  ])('%s 면 신호를 보내지 않는다', async (_, lockPid, s) => {
    const d = deps();
    await lockWith(lockPid, s);
    await stopTranscribe(d);
    expect(d.kill).not.toHaveBeenCalled();
  });

  it('신호를 받고 잠금을 못 푼 채 끝나도(시작 직후) 중지로 본다', async () => {
    let alive = true;
    const d = { kill: vi.fn(() => void (alive = false)), isAlive: vi.fn(() => alive), timeoutMs: 1000 };
    await lockWith(OTHER);
    await expect(stopTranscribe(d)).resolves.toContain('중지했습니다');
  });

  it('transcribe_status 의 stale 은 중지와 같은 기준이다 (프로세스 없음 또는 갱신 끊김)', () => {
    const now = Date.now();
    const old = new Date(now - TRANSCRIBE_STATE_STALE_MS - 1000).toISOString();
    expect(transcribeStatusState(running({ pid: process.pid }), now)?.stale).toBe(false);
    expect(transcribeStatusState(running({ pid: process.pid, updatedAt: old }), now)?.stale).toBe(true);
    // Linux pid 상한(2^22)보다 큰 pid — 살아 있을 수 없다
    expect(transcribeStatusState(running({ pid: 2 ** 22 + 1 }), now)?.stale).toBe(true);
    expect(transcribeStatusState(running({ pid: process.pid, status: 'done', updatedAt: old }), now)?.stale).toBe(
      false
    );
    expect(transcribeStatusState(null, now)).toBeNull();
  });

  it('제때 끝나지 않으면 확인 안내', async () => {
    const d = { kill: vi.fn(), isAlive: vi.fn(() => true), timeoutMs: 200 };
    await lockWith(OTHER);
    await expect(stopTranscribe(d)).resolves.toContain('아직 끝나지 않았습니다');
  });
});
