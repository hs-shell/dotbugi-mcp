import { VOD_MAX_SEGMENTS, VOD_MEDIA_HOST, VOD_MEDIA_TIMEOUT_MS, VOD_PLAYLIST_MAX_BYTES } from '../constants.js';

// 이 파일의 오류 메시지에는 주소를 넣지 않는다 — 경로에 시간 제한 토큰이 있다

const isMediaUrl = (url: URL | null): url is URL =>
  !!url &&
  url.protocol === 'https:' &&
  !url.username &&
  !url.password &&
  !url.port &&
  VOD_MEDIA_HOST.test(url.hostname);

// viewer.php 의 JW Player 설정 sources: [{file: '<m3u8>'}] 에서 CDN 주소만 꺼낸다
export function extractPlaylistUrl(html: string): URL {
  for (const m of html.matchAll(/\bfile\s*:\s*(['"])(https:\/\/[^'"\s\\<>]+?\.m3u8)\1/g)) {
    const url = URL.parse(m[2]);
    if (isMediaUrl(url)) return url;
  }
  throw new Error('강의 화면에서 허용된 영상 주소를 찾지 못했습니다.');
}

// 영상 CDN 전용 요청. 쿠키·인증 없이 정확히 host 로만 보내고, 리다이렉트는 따라가지 않으며, 받은 바이트를 직접 세어 자른다
export async function mediaGet(
  url: URL,
  host: string,
  maxBytes: number,
  signal: AbortSignal,
  fetchImpl: typeof fetch = fetch
): Promise<Uint8Array> {
  if (!isMediaUrl(url) || url.hostname !== host) throw new Error('허용되지 않은 영상 주소라 받지 않습니다.');
  let res: Response;
  try {
    res = await fetchImpl(url, {
      redirect: 'manual',
      credentials: 'omit',
      signal: AbortSignal.any([signal, AbortSignal.timeout(VOD_MEDIA_TIMEOUT_MS)]),
    });
  } catch (err) {
    if (signal.aborted) throw err;
    // 원래 오류(주소가 섞일 수 있음) 대신 고정 문구
    throw new Error('영상 서버에 연결하지 못했습니다.');
  }
  if (res.status >= 300 && res.status < 400) {
    await res.body?.cancel();
    throw new Error('영상 서버가 다른 주소로 이동시켜 중단했습니다.');
  }
  if (!res.ok || !res.body) throw new Error(`영상 서버 응답 오류 HTTP ${res.status}`);
  const chunks: Uint8Array[] = [];
  let size = 0;
  const reader = res.body.getReader();
  try {
    for (let c = await reader.read(); !c.done; c = await reader.read()) {
      size += c.value.byteLength;
      if (size > maxBytes) throw new Error(`영상 파일이 상한(${maxBytes / 1024 / 1024}MB)을 넘습니다.`);
      chunks.push(c.value);
    }
  } catch (err) {
    await reader.cancel().catch(() => {});
    if (signal.aborted || size > maxBytes) throw err;
    throw new Error(`영상 서버가 ${VOD_MEDIA_TIMEOUT_MS / 1000}초 안에 내려보내지 못했습니다.`);
  }
  return Buffer.concat(chunks);
}

// 단일 미디어 재생 목록만 받는다 (실측 LMS 는 variant 없음). 암호화·다른 호스트·부분 범위·지원하지 않는 형식은 거부한다
export function parsePlaylist(text: string, base: URL): { segments: URL[]; seconds: number } {
  const lines = text.split(/\r?\n/).map((l) => l.trim());
  if (lines[0] !== '#EXTM3U') throw new Error('영상 재생 목록 형식이 아닙니다.');
  const segments: URL[] = [];
  let seconds = 0;
  for (const line of lines.slice(1)) {
    if (!line) continue;
    if (/^#EXT-X-(SESSION-)?KEY:/.test(line) && !/[:,]METHOD=NONE(,|$)/.test(line))
      throw new Error('암호화된 영상이라 받아쓸 수 없습니다.');
    // 이어 붙이기 방식으로 다룰 수 없는 형식: 화질별 목록(마스터), 초기화 세그먼트(fMP4), 바이트 범위
    if (/^#EXT-X-(STREAM-INF|MAP|BYTERANGE):/.test(line)) throw new Error('지원하지 않는 영상 형식입니다.');
    const inf = /^#EXTINF:([\d.]+)/.exec(line);
    if (inf) seconds += Number(inf[1]);
    if (line.startsWith('#')) continue;
    const url = URL.parse(line, base);
    if (!isMediaUrl(url) || url.hostname !== base.hostname)
      throw new Error('재생 목록이 다른 서버의 주소를 가리켜 중단했습니다.');
    segments.push(url);
    if (segments.length > VOD_MAX_SEGMENTS) throw new Error('영상이 너무 길어 STT 변환하지 않습니다.');
  }
  if (segments.length === 0) throw new Error('영상 재생 목록이 비어 있습니다.');
  return { segments, seconds };
}

export async function loadSegments(
  playlistUrl: URL,
  signal: AbortSignal,
  fetchImpl: typeof fetch = fetch
): Promise<{ segments: URL[]; seconds: number }> {
  const data = await mediaGet(playlistUrl, playlistUrl.hostname, VOD_PLAYLIST_MAX_BYTES, signal, fetchImpl);
  return parsePlaylist(new TextDecoder().decode(data), playlistUrl);
}
