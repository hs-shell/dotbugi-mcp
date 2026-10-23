import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import type { spawn } from 'node:child_process';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { acquireLock } from '../player/lock.js';
import { extractPlaylistUrl, mediaGet, parsePlaylist } from '../transcribe/hls.js';
import { transcribeVod, type TranscribeDeps } from '../transcribe/pipeline.js';
import { readTranscribeState, TRANSCRIBE_LOCK_FILE, writeTranscribeState } from '../transcribe/state.js';
import { startWorker } from '../tools/transcribe-vod.js';

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
    expect(list).toMatchObject({ kind: 'media', seconds: 20 });
    if (list.kind === 'media') expect(list.segments[1].href).toBe(PLAYLIST.replace('index.m3u8', 'segment-2-v1-a1.ts'));
  });

  it('METHOD=NONE 이 아닌 EXT-X-KEY 는 거부한다', () => {
    expect(() => parsePlaylist(media(['s.ts'], '#EXT-X-KEY:METHOD=AES-128,URI="k"'), base)).toThrow('암호화');
    expect(() => parsePlaylist(media(['s.ts'], '#EXT-X-SESSION-KEY:METHOD=SAMPLE-AES,URI="k"'), base)).toThrow(
      '암호화'
    );
    expect(parsePlaylist(media(['s.ts'], '#EXT-X-KEY:METHOD=NONE'), base).kind).toBe('media');
  });

  it.each(['https://evil.com/s.ts', `http://${HOST}/s.ts`, `//other.edge.naverncp.com/s.ts`])(
    '다른 호스트 세그먼트는 거부한다: %s',
    (seg) => {
      expect(() => parsePlaylist(media([seg]), base)).toThrow('다른 서버');
    }
  );

  it('마스터 목록이면 같은 호스트의 가장 낮은 대역폭을 고르고, 다른 호스트 variant 는 거부한다', () => {
    const master = '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=900000\nhi.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=100000\nlo.m3u8';
    expect(parsePlaylist(master, base)).toMatchObject({ kind: 'master', variant: new URL('lo.m3u8', base) });
    expect(() => parsePlaylist('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\nhttps://evil.com/v.m3u8', base)).toThrow(
      '다른 서버'
    );
  });

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
type Child = EventEmitter & { stdout: PassThrough; stdin: PassThrough };
function fakeSpawn(opts: { asrCode?: number; text?: string } = {}) {
  const calls: { command: string; args: string[] }[] = [];
  const impl = ((command: string, args: string[]) => {
    calls.push({ command, args });
    const c = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stdin: new PassThrough() }) as Child;
    setImmediate(() => {
      if (command === 'ffmpeg') c.stdout.end(Buffer.alloc(64_000), () => setImmediate(() => c.emit('close', 0)));
      else {
        c.stdin.resume();
        c.stdin.on('end', () =>
          c.stdout.end(opts.text ?? '안녕하세요 강의입니다\n', () =>
            setImmediate(() => c.emit('close', opts.asrCode ?? 0))
          )
        );
      }
    });
    return c;
  }) as unknown as typeof spawn;
  return { impl, calls };
}

function deps(over: Partial<TranscribeDeps> = {}) {
  const reports: unknown[] = [];
  const fetched: string[] = [];
  const files: Record<string, string | Uint8Array<ArrayBuffer>> = {
    [PLAYLIST]: media(['segment-1-v1-a1.ts', 'segment-2-v1-a1.ts']),
    [PLAYLIST.replace('index.m3u8', 'segment-1-v1-a1.ts')]: new Uint8Array([1, 2]),
    [PLAYLIST.replace('index.m3u8', 'segment-2-v1-a1.ts')]: new Uint8Array([3]),
  };
  const sp = fakeSpawn();
  const d: TranscribeDeps = {
    findVod: async () => ({ course: '자료구조', title: '1강 소개', week: 3, courseId: '123' }),
    viewerHtml: async () => viewer(PLAYLIST),
    runtime: async () => ({ ffmpeg: 'ffmpeg', kind: 'cpu', command: 'qwen_asr', args: ['-S', '30'], model: '0.6b' }),
    fetch: (async (url: URL) => {
      fetched.push(url.href);
      const body = files[url.href];
      return body === undefined ? new Response(null, { status: 404 }) : new Response(body);
    }) as typeof fetch,
    spawn: sp.impl,
    root: join(dir, 'root'),
    tmpRoot: join(dir, 'tmp'),
    now: () => new Date('2026-10-24T03:00:00Z'),
    report: (phase, progress) => reports.push({ phase, progress }),
    signal: new AbortController().signal,
    ...over,
  };
  return { d, reports, fetched, files, sp };
}

const OUT = () => join(dir, 'root', '자료구조', '3주차', '녹취-1강 소개.md');

describe('transcribeVod', () => {
  beforeEach(() => mkdir(join(dir, 'tmp')));

  it('받아 쓴 글을 주차 폴더에 저장하고 임시 폴더를 지운다. ffmpeg 에는 로컬 파일만 넘긴다', async () => {
    const { d, reports, sp } = deps();
    expect(await transcribeVod(42, d)).toEqual({ status: 'done', path: OUT() });
    const md = await readFile(OUT(), 'utf8');
    expect(md).toContain('# 녹취 — 1강 소개');
    expect(md).toContain('- 과목: 자료구조');
    expect(md).toContain('- 받아쓴 날: 2026-10-24');
    expect(md).toContain('0.6b (cpu)');
    expect(md).toContain('안녕하세요 강의입니다');
    if (process.platform !== 'win32') expect((await stat(OUT())).mode & 0o777).toBe(0o600);
    expect(await readdir(join(dir, 'tmp'))).toEqual([]);
    const ff = sp.calls.find((c) => c.command === 'ffmpeg')!;
    expect(ff.args).toEqual(expect.arrayContaining(['-protocol_whitelist', 'file,pipe', 'pipe:1']));
    expect(ff.args.join(' ')).not.toMatch(/https?:/);
    expect(JSON.stringify(reports)).not.toContain(HOST);
    expect(reports).toContainEqual({ phase: 'download', progress: 100 });
  });

  it('이미 녹취가 있으면 받지 않고 건너뛴다 (덮어쓰지 않음)', async () => {
    await mkdir(join(dir, 'root', '자료구조', '3주차'), { recursive: true });
    await writeFile(OUT(), '내 메모');
    const { d, fetched } = deps();
    expect((await transcribeVod(42, d)).status).toBe('skipped');
    expect(await readFile(OUT(), 'utf8')).toBe('내 메모');
    expect(fetched).toEqual([]);
  });

  it('세그먼트를 못 받으면 실패하고 임시 폴더를 지운다', async () => {
    const { d, files } = deps();
    delete files[PLAYLIST.replace('index.m3u8', 'segment-2-v1-a1.ts')];
    await expect(transcribeVod(42, d)).rejects.toThrow('HTTP 404');
    expect(await readdir(join(dir, 'tmp'))).toEqual([]);
    await expect(stat(OUT())).rejects.toThrow();
  });

  it('ASR 이 실패하면 오류로 끝나고 임시 폴더를 지운다', async () => {
    const { d } = deps({ spawn: fakeSpawn({ asrCode: 3 }).impl });
    await expect(transcribeVod(42, d)).rejects.toThrow('종료 코드 3');
    expect(await readdir(join(dir, 'tmp'))).toEqual([]);
  });

  it('ASR 런타임이 없으면 아무것도 받지 않는다', async () => {
    const { d, fetched } = deps({ runtime: () => Promise.reject(new Error('ASR 런타임이 설치되지 않았습니다')) });
    await expect(transcribeVod(42, d)).rejects.toThrow('설치되지 않았습니다');
    expect(fetched).toEqual([]);
  });
});

describe('상태 파일·작업 잠금', () => {
  it('메시지에 섞인 주소는 지우고 0600 으로 쓴다', async () => {
    const file = join(dir, 'cache', 'transcribe-state.json');
    await writeTranscribeState(
      {
        version: 1,
        status: 'error',
        phase: null,
        progress: null,
        course: '자료구조',
        title: '1강',
        pid: process.pid,
        updatedAt: new Date().toISOString(),
        message: `실패: ${PLAYLIST}`,
      },
      file
    );
    const raw = await readFile(file, 'utf8');
    expect(raw).not.toContain(TOKEN);
    expect(raw).not.toContain(HOST);
    expect(readTranscribeState(file)?.message).toBe('실패: [URL]');
    if (process.platform !== 'win32') expect((await stat(file)).mode & 0o777).toBe(0o600);
  });

  it('실행 중인 작업이 있으면 새 작업을 띄우지 않고, 없으면 인자 배열로 분리 실행한다', async () => {
    const spawnImpl = vi.fn(() => {
      const c = Object.assign(new EventEmitter(), { unref: vi.fn() });
      setImmediate(() => c.emit('spawn'));
      return c;
    });
    const release = await acquireLock(TRANSCRIBE_LOCK_FILE);
    expect(TRANSCRIBE_LOCK_FILE.startsWith(state.home)).toBe(true);
    await expect(startWorker(42, spawnImpl as unknown as typeof spawn)).rejects.toThrow('이미 받아쓰기가 실행 중');
    expect(spawnImpl).not.toHaveBeenCalled();
    await release();

    await startWorker(42, spawnImpl as unknown as typeof spawn);
    expect(spawnImpl).toHaveBeenCalledWith(
      process.execPath,
      [expect.stringMatching(/index\.js$/), 'transcribe', '--worker', '42'],
      { detached: true, stdio: 'ignore' }
    );
  });
});
