import { inflateRawSync } from 'node:zlib';

// 휠(zip)에서 파일 하나만 꺼낸다. 입력 휠과 꺼낸 결과를 호출 쪽이 sha256 으로 검증하므로 최소한의 파서로 충분하다
export function extractZipEntry(zip: Buffer, name: string): Buffer {
  const eocd = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (eocd < 0) throw new Error('zip 형식이 아닙니다.');
  let p = zip.readUInt32LE(eocd + 16);
  for (let i = zip.readUInt16LE(eocd + 10); i > 0; i--) {
    if (zip.readUInt32LE(p) !== 0x02014b50) break;
    const method = zip.readUInt16LE(p + 10);
    const compressed = zip.readUInt32LE(p + 20);
    const size = zip.readUInt32LE(p + 24);
    const nameLen = zip.readUInt16LE(p + 28);
    const local = zip.readUInt32LE(p + 42);
    if (zip.toString('utf8', p + 46, p + 46 + nameLen) === name) {
      const start = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
      const raw = zip.subarray(start, start + compressed);
      if (method === 0) return Buffer.from(raw);
      if (method === 8) return inflateRawSync(raw, { maxOutputLength: size });
      throw new Error(`지원하지 않는 압축 방식입니다 (${method}).`);
    }
    p += 46 + nameLen + zip.readUInt16LE(p + 30) + zip.readUInt16LE(p + 32);
  }
  throw new Error(`zip 안에 ${name} 이(가) 없습니다.`);
}
