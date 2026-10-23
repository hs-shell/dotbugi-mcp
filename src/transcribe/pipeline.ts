import type { ChildProcess, spawn } from 'node:child_process';
import { lstat, mkdtemp, open, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { safeFileName } from '../assign/download.js';
import type { AsrRuntime } from '../asr/runtime.js';
import { LMS_NUMERIC_ID, TRANSCRIPT_MAX_BYTES, VOD_MEDIA_MAX_BYTES, VOD_SEGMENT_MAX_BYTES } from '../constants.js';
import { childDir, ensureRealDir, openCourseDir } from '../materials/sync.js';
import { extractPlaylistUrl, loadSegments, mediaGet } from './hls.js';

export interface VodMeta {
  course: string;
  title: string;
  week: number;
  courseId: string;
}
export type Phase = 'prepare' | 'download' | 'extract' | 'transcribe';

export interface TranscribeDeps {
  findVod(cmid: number): Promise<VodMeta>;
  // LMS 세션으로 받은 viewer.php HTML
  viewerHtml(cmid: number): Promise<string>;
  runtime(): Promise<AsrRuntime>;
  // 영상 CDN 전용 (세션 없음)
  fetch: typeof fetch;
  spawn: typeof spawn;
  // 강의자료 폴더 (~/Downloads/dotbugi-mcp)
  root: string;
  tmpRoot: string;
  now(): Date;
  report(phase: Phase, progress: number | null): void;
  signal: AbortSignal;
}

export interface TranscribeResult {
  status: 'done' | 'skipped';
  path: string;
}

// 16kHz · mono · 16bit
const PCM_BYTES_PER_SECOND = 32_000;

function exited(child: ChildProcess, name: string): Promise<void> {
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code) =>
      code === 0 ? resolve() : reject(new Error(`${name} 이(가) 실패했습니다 (종료 코드 ${code}).`))
    );
  });
}

// ffmpeg 로 로컬 파일의 소리만 PCM 으로 뽑아 ASR stdin 에 잇는다. ffmpeg 는 file·pipe 프로토콜만 쓴다 (네트워크 주소를 따라가지 않게)
async function transcribeFile(media: string, seconds: number, rt: AsrRuntime, deps: TranscribeDeps): Promise<string> {
  const ac = new AbortController();
  const signal = AbortSignal.any([deps.signal, ac.signal]);
  deps.report('extract', null);
  const ff = deps.spawn(
    rt.ffmpeg,
    // prettier-ignore
    ['-nostdin', '-hide_banner', '-loglevel', 'error', '-protocol_whitelist', 'file,pipe', '-f', 'mpegts', '-i', media,
      '-vn', '-ac', '1', '-ar', '16000', '-f', 's16le', 'pipe:1'],
    { stdio: ['ignore', 'pipe', 'ignore'], signal }
  );
  const asr = deps.spawn(rt.command, rt.args, {
    stdio: ['pipe', 'pipe', 'ignore'],
    env: { ...process.env, ...rt.env },
    signal,
  });
  // ASR 이 읽어 간 만큼으로 진행률을 어림한다 (파이프가 막히면 ffmpeg 도 기다린다)
  const expected = seconds * PCM_BYTES_PER_SECOND;
  let fed = 0;
  let last: number | null = -1;
  const counter = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      fed += chunk.length;
      const p = expected > 0 ? Math.min(99, Math.floor((fed / expected) * 100)) : null;
      if (p !== last) deps.report('transcribe', (last = p));
      cb(null, chunk);
    },
  });
  const out: Buffer[] = [];
  let size = 0;
  let tooLarge = false;
  asr.stdout!.on('data', (chunk: Buffer) => {
    size += chunk.length;
    if (size <= TRANSCRIPT_MAX_BYTES) out.push(chunk);
    else if (!tooLarge) {
      tooLarge = true;
      ac.abort();
    }
  });
  try {
    await Promise.all([pipeline(ff.stdout!, counter, asr.stdin!), exited(ff, 'ffmpeg'), exited(asr, '받아쓰기')]);
  } catch (err) {
    ac.abort();
    if (tooLarge) throw new Error('받아쓴 글이 상한을 넘어 중단했습니다.');
    throw err;
  }
  const text = Buffer.concat(out).toString('utf8').trim();
  if (!text) throw new Error('받아쓴 내용이 없습니다 (소리가 없는 강의일 수 있습니다).');
  return text;
}

// VOD 하나 → ~/Downloads/dotbugi-mcp/<과목>/<N주차>/녹취-<강의명>.md. 이미 있으면 건너뛴다(덮어쓰지 않음). 임시 파일은 어떤 경우에도 지운다
export async function transcribeVod(cmid: number, deps: TranscribeDeps): Promise<TranscribeResult> {
  deps.report('prepare', null);
  // 받기 전에 확인 — 설치 안 됐으면 내려받지 않는다
  const rt = await deps.runtime();
  const meta = await deps.findVod(cmid);
  if (!LMS_NUMERIC_ID.test(meta.courseId)) throw new Error('과목 번호 형식이 올바르지 않습니다.');
  const { dir: courseDir } = await openCourseDir(deps.root, meta.course, meta.courseId);
  const weekDir = childDir(courseDir, `${meta.week}주차`);
  const path = join(weekDir, safeFileName(`녹취-${meta.title}.md`));
  if (await lstat(path).catch(() => null)) return { status: 'skipped', path };

  // mkdtemp 는 0700 으로 만든다
  const tmp = await mkdtemp(join(deps.tmpRoot, 'dotbugi-transcribe-'));
  try {
    const playlist = extractPlaylistUrl(await deps.viewerHtml(cmid));
    const { segments, seconds } = await loadSegments(playlist, deps.signal, deps.fetch);
    // MPEG-TS 는 이어 붙이면 그대로 하나의 스트림이다 — 파일 하나로 모아 ffmpeg 인자에 주소·목록이 들어가지 않게
    const media = join(tmp, 'media.ts');
    const file = await open(media, 'wx', 0o600);
    try {
      let total = 0;
      // 하나씩 받는다 — CDN 에 요청을 겹쳐 보내지 않는다
      for (const [i, segment] of segments.entries()) {
        const data = await mediaGet(segment, playlist.hostname, VOD_SEGMENT_MAX_BYTES, deps.signal, deps.fetch);
        total += data.byteLength;
        if (total > VOD_MEDIA_MAX_BYTES)
          throw new Error(`영상이 상한(${VOD_MEDIA_MAX_BYTES / 1024 ** 3}GB)을 넘습니다.`);
        await file.write(data);
        deps.report('download', Math.floor(((i + 1) / segments.length) * 100));
      }
    } finally {
      await file.close();
    }
    const text = await transcribeFile(media, seconds, rt, deps);

    await ensureRealDir(deps.root, weekDir);
    const date = deps.now().toLocaleDateString('sv-SE', { timeZone: 'Asia/Seoul' });
    const body = [
      `# 녹취 — ${meta.title}`,
      '',
      `- 과목: ${meta.course}`,
      `- 주차: ${meta.week}주차`,
      `- 받아쓴 날: ${date}`,
      `- 모델: Qwen3-ASR ${rt.model} (${rt.kind})`,
      '',
      text,
      '',
    ].join('\n');
    // wx: 그사이 생긴 파일(링크 포함)도 덮지 않는다
    const out = await open(path, 'wx', 0o600).catch((err: NodeJS.ErrnoException) => {
      if (err.code === 'EEXIST') return null;
      throw err;
    });
    if (!out) return { status: 'skipped', path };
    try {
      await out.writeFile(body);
    } finally {
      await out.close();
    }
    return { status: 'done', path };
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}
