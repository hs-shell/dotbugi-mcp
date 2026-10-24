import { inflateRawSync } from 'node:zlib';
import { DOC_TEXT_MAX_ENTRIES } from '../constants.js';
import type { Budget } from './budget.js';

const EOCD_SIG = 0x06054b50;
const CENTRAL_SIG = 0x02014b50;
const LOCAL_SIG = 0x04034b50;

interface Entry {
  method: number;
  encrypted: boolean;
  compSize: number;
  size: number;
  offset: number;
}

// 메모리 안의 zip 에서 이름으로 항목을 꺼낸다. 디스크에 풀지 않으므로 경로 이탈이 없다.
// shortcut: zip64·암호화·deflate 외 압축은 거부 — 오피스·한글 문서는 쓰지 않는다, 실제로 만나면 추가
export function openZip(buf: Buffer, budget: Budget): { names: string[]; read: (name: string) => Buffer | null } {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i--)
    if (buf.readUInt32LE(i) === EOCD_SIG) {
      eocd = i;
      break;
    }
  if (eocd < 0) throw new Error('zip 형식이 아닙니다.');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  if (count === 0xffff || p === 0xffffffff) throw new Error('zip64 문서는 아직 읽지 못합니다.');
  if (count > DOC_TEXT_MAX_ENTRIES) throw new Error('문서 안 항목이 너무 많아 읽지 않았습니다.');

  const entries = new Map<string, Entry>();
  for (let i = 0; i < count; i++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== CENTRAL_SIG) throw new Error('zip 목록이 깨졌습니다.');
    const nameLen = buf.readUInt16LE(p + 28);
    // 오피스·한글 문서의 내부 이름은 ASCII 라 인코딩 플래그를 따질 필요가 없다
    const name = buf.toString('latin1', p + 46, p + 46 + nameLen);
    entries.set(name, {
      encrypted: (buf.readUInt16LE(p + 8) & 1) === 1,
      method: buf.readUInt16LE(p + 10),
      compSize: buf.readUInt32LE(p + 20),
      size: buf.readUInt32LE(p + 24),
      offset: buf.readUInt32LE(p + 42),
    });
    p += 46 + nameLen + buf.readUInt16LE(p + 30) + buf.readUInt16LE(p + 32);
  }

  const read = (name: string): Buffer | null => {
    const e = entries.get(name);
    if (!e) return null;
    if (e.encrypted) throw new Error('암호가 걸린 문서는 읽지 못합니다.');
    const o = e.offset;
    if (o + 30 > buf.length || buf.readUInt32LE(o) !== LOCAL_SIG) throw new Error('zip 항목이 깨졌습니다.');
    const start = o + 30 + buf.readUInt16LE(o + 26) + buf.readUInt16LE(o + 28);
    if (start + e.compSize > buf.length) throw new Error('zip 항목이 깨졌습니다.');
    const raw = buf.subarray(start, start + e.compSize);
    let out: Buffer;
    if (e.method === 0) out = raw;
    else if (e.method === 8) {
      try {
        // 선언된 크기는 믿지 않는다 — 남은 예산까지만 푼다
        out = inflateRawSync(raw, { maxOutputLength: Math.max(1, budget.remaining) });
      } catch (err) {
        if (err instanceof RangeError) throw new Error('문서를 풀면 너무 커서 읽지 않았습니다.');
        throw new Error('zip 항목을 풀지 못했습니다.');
      }
    } else throw new Error(`지원하지 않는 zip 압축 방식(${e.method})입니다.`);
    budget.spend(out.length);
    return out;
  };
  return { names: [...entries.keys()], read };
}
