import { deflateRawSync } from 'node:zlib';
import CFB from 'cfb';

// 테스트용 최소 zip (deflate). flags 로 암호화 비트 등을 흉내 낸다
export function zip(files: Record<string, string | Buffer>, flags = 0): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const raw = Buffer.from(content);
    const data = deflateRawSync(raw);
    const n = Buffer.from(name);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(n.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(flags, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(n.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, n, data);
    centrals.push(central, n);
    offset += 30 + n.length + data.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(Object.keys(files).length, 8);
  eocd.writeUInt16LE(Object.keys(files).length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}

// HWP 레코드 하나: 태그 10비트 · 레벨 10비트 · 크기 12비트
export function record(tag: number, data: Buffer, level = 0): Buffer {
  const head = Buffer.alloc(4);
  head.writeUInt32LE((tag | (level << 10) | (data.length << 20)) >>> 0);
  return Buffer.concat([head, data]);
}

const PARA_TEXT = 67;
// 문단 글자. 제어 문자는 { ctrl } 로 넣는다 (8 글자짜리면 뒤 7 글자를 채운다)
export function paraText(...parts: (string | { ctrl: number; wide?: boolean })[]): Buffer {
  const units: number[] = [];
  for (const p of parts)
    if (typeof p === 'string') for (const ch of p) units.push(ch.charCodeAt(0));
    else units.push(p.ctrl, ...(p.wide ? [0x6c74, 0x6274, 0, 0, 0, 0, p.ctrl] : []));
  const buf = Buffer.alloc(units.length * 2);
  units.forEach((u, i) => buf.writeUInt16LE(u, i * 2));
  return record(PARA_TEXT, buf);
}

// 테스트용 HWP 5.0: FileHeader + BodyText/Section<n> (+ BinData 그림 bins 개). 압축 플래그면 본문을 raw deflate 로
export function hwp(sections: Buffer[][], flags = 1, bins = 0): Buffer {
  const doc = CFB.utils.cfb_new();
  const header = Buffer.alloc(256);
  header.write('HWP Document File', 'latin1');
  header.writeUInt32LE(0x05000500, 32);
  header.writeUInt32LE(flags, 36);
  CFB.utils.cfb_add(doc, '/FileHeader', header);
  sections.forEach((records, i) => {
    const body = Buffer.concat([record(66, Buffer.alloc(22)), ...records]);
    CFB.utils.cfb_add(doc, `/BodyText/Section${i}`, flags & 1 ? deflateRawSync(body) : body);
  });
  for (let i = 1; i <= bins; i++) CFB.utils.cfb_add(doc, `/BinData/BIN000${i}.png`, PNG);
  return Buffer.from(CFB.write(doc, { type: 'buffer' }) as Buffer);
}

// 매직 바이트만 맞춘 최소 그림 (내용 확인용 꼬리표를 붙인다)
export const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
export const png = (tag: string) => Buffer.concat([PNG, Buffer.from(tag)]);
export const jpg = (tag: string) => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.from(tag)]);

const rels = (targets: Record<string, string>) =>
  `<Relationships>${Object.entries(targets)
    .map(([id, t]) => `<Relationship Id="${id}" Type="http://x/image" Target="${t}"/>`)
    .join('')}</Relationships>`;

// 테스트용 pptx: 슬라이드마다 [글, 그림 파일 이름들]. 그림은 ppt/media/<이름> 에 media 로 넣는다
export function pptx(slides: [string, string[]][], media: Record<string, Buffer>): Buffer {
  const files: Record<string, string | Buffer> = {};
  slides.forEach(([text, imgs], i) => {
    files[`ppt/slides/slide${i + 1}.xml`] =
      `<p:sld><p:sp><a:p><a:t>${text}</a:t></a:p></p:sp>${imgs.map((_, j) => `<a:blip r:embed="rId${j + 1}"/>`).join('')}</p:sld>`;
    files[`ppt/slides/_rels/slide${i + 1}.xml.rels`] = rels(
      Object.fromEntries(imgs.map((m, j) => [`rId${j + 1}`, `../media/${m}`]))
    );
  });
  for (const [k, v] of Object.entries(media)) files[`ppt/media/${k}`] = v;
  return zip(files);
}
