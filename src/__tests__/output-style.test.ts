import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(import.meta.dirname, '..', '..');

function files(dir: string, ext: RegExp): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const path = join(dir, e.name);
    if (e.isDirectory()) return e.name === 'node_modules' ? [] : files(path, ext);
    return ext.test(e.name) ? [path] : [];
  });
}

// 줄마다 [파일:줄, 내용] — 실패 메시지에 위치가 바로 보이게
const lines = (paths: string[]) =>
  paths.flatMap((p) =>
    readFileSync(p, 'utf8')
      .split(/\r?\n/)
      .map((text, i) => [`${relative(ROOT, p)}:${i + 1}`, text] as const)
  );

describe('출력 문구 규칙', () => {
  it('소스·문서에 이모지가 없다 (✓ ✗ ● ○ ▸ ※ 같은 유니코드 기호만)', () => {
    const scanned = [
      ...files(join(ROOT, 'src'), /\.(ts|py)$/),
      ...files(join(ROOT, 'docs'), /\.md$/),
      join(ROOT, 'README.md'),
    ];
    // U+26A0 경고 기호처럼 글자 기호지만 이모지로 그려질 수 있는 것도 Extended_Pictographic 에 들어간다
    // 국기(지역 표시 문자 쌍)·키캡 결합 문자는 Extended_Pictographic 밖이라 따로 잡는다
    const found = lines(scanned).filter(([, text]) =>
      /\p{Extended_Pictographic}|\p{Regional_Indicator}|\u{FE0F}|\u{20E3}/u.test(text)
    );
    expect(found).toEqual([]);
  });

  it('사용자 문구는 받아쓰기·녹취 대신 STT 를 쓴다', () => {
    const scanned = files(join(ROOT, 'src'), /\.ts$/).filter((p) => !p.includes('__tests__'));
    const found = lines(scanned).filter(([at, text]) => {
      // 서버 안내(모델용)의 인식 키워드 한 줄은 허용 — "받아써 줘" 를 transcribe_lecture 로 잇는 라우팅이라 사용자 문구가 아니다
      if (at.startsWith(join('src', 'instructions.ts:')) && text.startsWith('- "받아써 줘"')) return false;
      const code = text
        // 주석은 사람(개발자)용이라 뺀다 — 주소의 :// 는 앞이 공백이 아니라 남는다
        .replace(/(^|\s)\/\/.*$/, '')
        .replace(/^\s*\*.*$/, '');
      return /받아쓰|받아써|녹취/.test(code) && !code.includes('LEGACY_PREFIX =');
    });
    expect(found).toEqual([]);
  });

  it('README·docs 는 받아쓰기·녹취·VOD 대신 STT·동영상 강의를 쓴다', () => {
    const scanned = [...files(join(ROOT, 'docs'), /\.md$/), join(ROOT, 'README.md')];
    // 인자 값 `vod`·주소 `mod/vod` 는 소문자라 걸리지 않는다
    const found = lines(scanned).filter(([, text]) => /받아쓰|받아써|녹취|VOD/.test(text));
    expect(found).toEqual([]);
  });

  // #134 에서 슬래시 명령에 맞춰 바꾼 도구 이름 — 옛 이름이 다시 들어오면 모델이 없는 도구를 부른다 (CHANGELOG 는 기록이라 제외)
  it('소스·문서에 옛 도구 이름(sync_materials·list_tasks·transcribe_vod)이 없다', () => {
    const scanned = [
      ...files(join(ROOT, 'src'), /\.ts$/).filter((p) => !p.endsWith('output-style.test.ts')),
      ...files(join(ROOT, 'docs'), /\.md$/),
      join(ROOT, 'README.md'),
    ];
    const found = lines(scanned).filter(([, text]) => /\b(sync_materials|list_tasks|transcribe_vod)\b/.test(text));
    expect(found).toEqual([]);
  });
});
