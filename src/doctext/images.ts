import { posix } from 'node:path';

// 문서 안 그림 하나. label 은 모델이 어느 슬라이드·구역의 그림인지 알게 붙이는 자리 표시, entry 는 zip 안 이름
export interface DocImageRef {
  label: string;
  entry: string;
}

// 속성 문자열에서 이름="값" 하나. 그림 목록은 rels·manifest 의 한 줄짜리 빈 태그라 정규식으로 충분하다
const attr = (attrs: string, name: string) => new RegExp(`(?:^|\\s)${name}="([^"]*)"`).exec(attrs)?.[1];

// rels 의 Id → zip 안 이름. 외부 링크(TargetMode="External")는 버린다 — 네트워크로 가져오지 않는다
function relTargets(rels: string, baseDir: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const [, attrs] of rels.matchAll(/<Relationship\b([^<>]*)>/g)) {
    const id = attr(attrs, 'Id');
    const target = attr(attrs, 'Target');
    if (!id || !target || attr(attrs, 'TargetMode') === 'External') continue;
    map.set(id, target.startsWith('/') ? target.slice(1) : posix.join(baseDir, target));
  }
  return map;
}

// 그림은 정해진 폴더 안의 항목만 — 정규화한 이름이 그 폴더를 벗어나면(../ 등) 버린다
const inside = (entry: string | undefined, dir: string) =>
  entry && posix.normalize(entry) === entry && entry.startsWith(dir) && !entry.split('/').includes('..')
    ? entry
    : undefined;

// 본문 XML 에 나온 순서대로, 같은 그림은 처음 나온 자리에서 한 번만
function collect(out: DocImageRef[], seen: Set<string>, label: string, entries: (string | undefined)[]) {
  for (const e of entries)
    if (e && !seen.has(e)) {
      seen.add(e);
      out.push({ label, entry: e });
    }
}

// pptx: 슬라이드 순서 → 슬라이드 XML 의 r:embed 순서 → rels 로 ppt/media/ 항목. 숨긴 슬라이드의 그림은 글처럼 버린다
export function pptxImages(slides: string[], str: (n: string) => string): DocImageRef[] {
  const out: DocImageRef[] = [];
  const seen = new Set<string>();
  slides.forEach((name, i) => {
    const xml = str(name);
    if (/<p:sld\b[^<>]*\bshow="(0|false)"/.test(xml)) return;
    const rels = relTargets(
      str(posix.join(posix.dirname(name), '_rels', `${posix.basename(name)}.rels`)),
      'ppt/slides'
    );
    const ids = [...xml.matchAll(/\br:embed="([^"]+)"/g)].map((m) => inside(rels.get(m[1]), 'ppt/media/'));
    collect(out, seen, `슬라이드 ${i + 1}`, ids);
  });
  return out;
}

// docx: document.xml 의 r:embed 순서 → word/_rels/document.xml.rels 로 word/media/ 항목 (쪽 번호는 알 수 없어 본문 순번만)
export function docxImages(str: (n: string) => string): DocImageRef[] {
  const rels = relTargets(str('word/_rels/document.xml.rels'), 'word');
  const out: DocImageRef[] = [];
  collect(
    out,
    new Set(),
    '본문',
    [...str('word/document.xml').matchAll(/\br:embed="([^"]+)"/g)].map((m) => inside(rels.get(m[1]), 'word/media/'))
  );
  return out;
}

// hwpx: 구역 XML 의 binaryItemIDRef 순서 → Contents/content.hpf 의 item href 로 BinData/ 항목
export function hwpxImages(sections: string[], str: (n: string) => string): DocImageRef[] {
  const items = new Map<string, string>();
  for (const [, attrs] of str('Contents/content.hpf').matchAll(/<(?:[\w-]+:)?item\b([^<>]*)>/g)) {
    const id = attr(attrs, 'id');
    const href = attr(attrs, 'href');
    if (id && href) items.set(id, href);
  }
  const out: DocImageRef[] = [];
  const seen = new Set<string>();
  sections.forEach((name, i) => {
    const ids = [...str(name).matchAll(/\bbinaryItemIDRef="([^"]+)"/g)].map((m) => inside(items.get(m[1]), 'BinData/'));
    collect(out, seen, `구역 ${i + 1}`, ids);
  });
  return out;
}

// 그림 바이트는 믿을 수 없다 — 확장자·선언 형식 대신 앞 바이트(매직)로 형식을 정하고, 모르는 형식(emf·wmf·svg 등)은 null
export function imageMime(data: Buffer): string | null {
  if (data.length >= 8 && data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])))
    return 'image/png';
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return 'image/jpeg';
  if (data.length >= 6 && /^GIF8[79]a$/.test(data.toString('latin1', 0, 6))) return 'image/gif';
  return null;
}
