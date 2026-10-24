import { inflateRawSync } from 'node:zlib';
import CFB from 'cfb';
import { DOC_TEXT_MAX_ENTRIES } from '../constants.js';
import type { Budget } from './budget.js';

// HWP 5.0 문서 형식(한컴 공개 문서) 기준
const SIGNATURE = 'HWP Document File';
const COMPRESSED = 1;
const PASSWORD = 2;
const DISTRIBUTION = 4;
// HWPTAG_BEGIN(0x10) + 51 — 문단의 글자
const PARA_TEXT = 67;
// 1 글자짜리 제어 문자. 나머지 0~31 은 8 글자(16바이트)를 차지하는 인라인·확장 제어(표·그림 자리 등)라 건너뛴다
const CHAR_CONTROLS = new Set([0, 10, 13, 24, 25, 26, 27, 28, 29, 30, 31]);

// 문단 글자(UTF-16LE) → 평문. 줄바꿈(10)·문단 끝(13)은 줄바꿈, 묶음·고정폭 빈칸(30·31)은 빈칸, 탭(9)은 탭
function paraText(data: Buffer): string {
  let out = '';
  for (let i = 0; i + 1 < data.length;) {
    const c = data.readUInt16LE(i);
    if (c >= 32) {
      out += String.fromCharCode(c);
      i += 2;
    } else if (CHAR_CONTROLS.has(c)) {
      if (c === 10 || c === 13) out += '\n';
      else if (c === 30 || c === 31) out += ' ';
      i += 2;
    } else {
      // 탭(9)은 8 글자짜리 인라인 제어
      if (c === 9) out += '\t';
      i += 16;
    }
  }
  return out;
}

// 레코드 머리: 태그 10비트 · 레벨 10비트 · 크기 12비트 (0xfff 면 뒤 4바이트가 크기)
function sectionText(data: Buffer, budget: Budget): string {
  const parts: string[] = [];
  for (let p = 0; p + 4 <= data.length;) {
    const head = data.readUInt32LE(p);
    let size = head >>> 20;
    p += 4;
    if (size === 0xfff) {
      if (p + 4 > data.length) break;
      size = data.readUInt32LE(p);
      p += 4;
    }
    if ((head & 0x3ff) === PARA_TEXT) parts.push(paraText(data.subarray(p, p + size)));
    p += size;
    if (parts.length % 1000 === 0) budget.check();
  }
  return parts.join('');
}

// 구형 한글(.hwp) 본문 글자. OLE 컨테이너는 cfb 로 열고, 본문 레코드는 직접 읽는다 (외부 프로세스·네이티브 없음)
export function hwpText(buf: Buffer, budget: Budget): string {
  if (buf.length < 512) throw new Error('한글(hwp) 문서 형식이 아닙니다.');
  // 한글이 쓴 파일 중엔 FAT 이 가리키는 끝 섹터가 파일에 없는 것이 있어 cfb 가 깨진다 —
  // FAT 이 덮는 크기(섹터 크기 · FAT 섹터 수)까지 0 으로 채워 읽는다 (olefile 과 같은 결과)
  const sectorSize = 1 << buf.readUInt16LE(30);
  const pad = 512 + buf.readUInt32LE(44) * (sectorSize / 4) * sectorSize - buf.length;
  if (pad > 0) budget.spend(pad);
  let doc: CFB.CFB$Container;
  try {
    doc = CFB.read(pad > 0 ? Buffer.concat([buf, Buffer.alloc(pad)]) : buf, { type: 'buffer' });
  } catch {
    throw new Error('한글(hwp) 문서 형식이 아닙니다.');
  }
  const header = CFB.find(doc, '/FileHeader')?.content as Buffer | undefined;
  if (!header || header.length < 40 || header.toString('latin1', 0, SIGNATURE.length) !== SIGNATURE)
    throw new Error('한글(hwp) 5.0 문서가 아닙니다 (한글 97 등 옛 형식은 읽지 못합니다).');
  const flags = header.readUInt32LE(36);
  if (flags & PASSWORD) throw new Error('암호가 걸린 한글 문서는 읽지 못합니다.');
  // 배포용 문서는 본문이 암호화돼 있다
  if (flags & DISTRIBUTION) throw new Error('배포용 한글 문서는 읽지 못합니다. 한글에서 직접 열어 보세요.');

  const sections: string[] = [];
  for (let i = 0; i < DOC_TEXT_MAX_ENTRIES; i++) {
    const raw = CFB.find(doc, `/BodyText/Section${i}`)?.content as Buffer | undefined;
    if (!raw) break;
    let data = Buffer.from(raw);
    if (flags & COMPRESSED) {
      try {
        data = inflateRawSync(data, { maxOutputLength: Math.max(1, budget.remaining) });
      } catch (err) {
        if (err instanceof RangeError) throw new Error('문서를 풀면 너무 커서 읽지 않았습니다.');
        throw new Error('한글 문서 본문을 풀지 못했습니다.');
      }
    }
    budget.spend(data.length);
    sections.push(sectionText(data, budget));
  }
  return sections.join('\n');
}
