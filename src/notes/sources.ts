import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { LEGACY_PREFIX } from '../transcribe/pipeline.js';

// 노트(나중엔 요약도)를 만들 때 쓴 자료의 지문. 다음 실행에서 비교해 바뀐 주차를 찾는다
export interface Source {
  name: string;
  sha256: string;
}

// STT 결과 파일 (이름을 바꾸기 전 예전 접두어 포함)
export const isTranscript = (name: string) =>
  name.endsWith('.md') && ['STT-', LEGACY_PREFIX].some((p) => name.startsWith(p) && name.length > p.length + 3);

export const sha256Of = (path: string) =>
  new Promise<string>((resolve, reject) => {
    const hash = createHash('sha256');
    createReadStream(path)
      .on('data', (chunk) => hash.update(chunk))
      .on('error', reject)
      .on('end', () => resolve(hash.digest('hex')));
  });

// 주차 폴더 바로 아래의 실제 파일(숨김·링크·우리 산출물 제외)을 이름순으로. 폴더가 없으면 빈 목록
export async function weekSources(dir: string, isOutput: (name: string) => boolean): Promise<Source[]> {
  const entries = await readdir(dir, { withFileTypes: true }).catch((err: NodeJS.ErrnoException) => {
    if (err.code === 'ENOENT') return [];
    throw err;
  });
  const names = entries
    .filter((e) => e.isFile() && !e.name.startsWith('.') && !isOutput(e.name))
    .map((e) => e.name)
    .sort();
  return Promise.all(names.map(async (name) => ({ name, sha256: await sha256Of(join(dir, name)) })));
}

const materialLabel = (name: string): string => (isTranscript(name) ? 'STT' : '강의자료');

// 이전 지문과 비교한 바뀐 점 (사람이 읽는 이유). 같으면 빈 배열. label 은 자료 종류 이름 (요약은 '노트')
export function sourceChanges(prev: Source[], cur: Source[], label = materialLabel): string[] {
  const before = new Map(prev.map((s) => [s.name, s.sha256]));
  const after = new Map(cur.map((s) => [s.name, s.sha256]));
  const reasons: string[] = [];
  for (const [name, sha] of after) {
    if (!before.has(name)) reasons.push(`${label(name)} 추가: ${name}`);
    else if (before.get(name) !== sha) reasons.push(`${label(name)} 수정: ${name}`);
  }
  for (const name of before.keys()) if (!after.has(name)) reasons.push(`${label(name)} 삭제: ${name}`);
  return reasons;
}
