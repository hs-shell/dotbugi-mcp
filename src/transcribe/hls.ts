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
  for (let c = await reader.read(); !c.done; c = await reader.read()) {
    size += c.value.byteLength;
    if (size > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new Error(`영상 파일이 상한(${maxBytes / 1024 / 1024}MB)을 넘습니다.`);
    }
    chunks.push(c.value);
  }
  return Buffer.concat(chunks);
}

export type Playlist = { kind: 'media'; segments: URL[]; seconds: number } | { kind: 'master'; variant: URL };

// 재생 목록 해석. 암호화·다른 호스트·지원하지 않는 형식은 거부한다. 주소는 base 기준으로 풀고 같은 호스트만 허용
export function parsePlaylist(text: string, base: URL): Playlist {
  const lines = text.split(/\r?\n/).map((l) => l.trim());
  if (lines[0] !== '#EXTM3U') throw new Error('영상 재생 목록 형식이 아닙니다.');
  const resolve = (ref: string) => {
    const url = URL.parse(ref, base);
    if (!isMediaUrl(url) || url.hostname !== base.hostname)
      throw new Error('재생 목록이 다른 서버의 주소를 가리켜 중단했습니다.');
    return url;
  };
  const segments: URL[] = [];
  const variants: { url: URL; bandwidth: number }[] = [];
  let seconds = 0;
  let pendingBandwidth: number | null = null;
  for (const line of lines.slice(1)) {
    if (!line) continue;
    if (/^#EXT-X-(SESSION-)?KEY:/.test(line) && !/METHOD=NONE(,|$)/.test(line))
      throw new Error('암호화된 영상이라 받아쓸 수 없습니다.');
    // 초기화 세그먼트(fMP4)는 이어 붙이기 방식으로 다룰 수 없다
    if (line.startsWith('#EXT-X-MAP:')) throw new Error('지원하지 않는 영상 형식입니다.');
    if (line.startsWith('#EXT-X-STREAM-INF:')) {
      pendingBandwidth = Number(/[:,]BANDWIDTH=(\d+)/.exec(line)?.[1] ?? Infinity);
      continue;
    }
    const inf = /^#EXTINF:([\d.]+)/.exec(line);
    if (inf) seconds += Number(inf[1]);
    if (line.startsWith('#')) continue;
    if (pendingBandwidth !== null) {
      variants.push({ url: resolve(line), bandwidth: pendingBandwidth });
      pendingBandwidth = null;
    } else segments.push(resolve(line));
    if (segments.length > VOD_MAX_SEGMENTS) throw new Error('영상이 너무 길어 받아쓰지 않습니다.');
  }
  if (variants.length > 0) {
    if (segments.length > 0) throw new Error('영상 재생 목록 형식이 올바르지 않습니다.');
    // 받아쓰기엔 화질이 필요 없다 — 가장 가벼운 것
    return { kind: 'master', variant: variants.sort((a, b) => a.bandwidth - b.bandwidth)[0].url };
  }
  if (segments.length === 0) throw new Error('영상 재생 목록이 비어 있습니다.');
  return { kind: 'media', segments, seconds };
}

// m3u8 → 세그먼트 목록. 마스터 목록이면 한 단계만 따라간다
export async function loadSegments(
  playlistUrl: URL,
  signal: AbortSignal,
  fetchImpl: typeof fetch = fetch
): Promise<{ segments: URL[]; seconds: number }> {
  const host = playlistUrl.hostname;
  const read = async (url: URL) =>
    parsePlaylist(new TextDecoder().decode(await mediaGet(url, host, VOD_PLAYLIST_MAX_BYTES, signal, fetchImpl)), url);
  let list = await read(playlistUrl);
  if (list.kind === 'master') list = await read(list.variant);
  if (list.kind !== 'media') throw new Error('영상 재생 목록 형식이 올바르지 않습니다.');
  return list;
}
