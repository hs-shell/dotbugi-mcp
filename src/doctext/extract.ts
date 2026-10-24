import { extname } from 'node:path';
import { Budget } from './budget.js';
import { hwpText } from './hwp.js';
import { openZip } from './zip.js';

export const DOC_EXT = new Set(['.hwp', '.hwpx', '.docx', '.pptx', '.xlsx']);

const ENTITY: Record<string, string> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };
const decode = (s: string) =>
  s.replace(/&(#x[\da-f]+|#\d+|\w+);/gi, (m, e: string) => {
    if (e[0] !== '#') return ENTITY[e] ?? m;
    const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : Number(e.slice(1));
    return n <= 0x10ffff ? String.fromCodePoint(n) : m;
  });

// 태그·글 토큰. 이름 뒤 (?![\w:.-]) 와 [^<>] 로 역추적이 다음 '<' 를 넘지 않게 해 선형을 지킨다
// (예전 [^>]*? · [\s\S]*? 는 '<a<a<a…' 같은 입력에서 제곱 시간 — 동기 정규식이라 시간 상한도 못 끊는다)
const TOKEN = /<(\/?)([\w:.-]+)(?![\w:.-])([^<>]*?)(\/?)>|([^<]+)/g;

// 태그를 한 줄로 훑어 글자 태그 안의 글만 모은다 (DOM 을 만들지 않아 큰 문서도 선형)
// text: 글자가 든 태그, para: 끝나면 줄바꿈하는 태그, tab·br: 빈 태그로 쓰이는 탭·줄바꿈
// hide: scope 요소 안에서 mark 가 참인 태그를 만나면 그 scope 가 닫힐 때까지 버린다 (숨김 글자 — 지시 숨김 통로 차단)
interface Hide {
  scope: string;
  mark: (name: string, attrs: string) => boolean;
}
function xmlText(
  xml: string,
  tags: { text: string[]; para: string[]; tab?: string[]; br?: string[]; hide?: Hide }
): string {
  let out = '';
  let inText = 0;
  let depth = 0;
  let hiddenAt = 0;
  for (const m of xml.matchAll(TOKEN)) {
    const [, close, name, attrs, selfClose, text] = m;
    if (text !== undefined) {
      if (inText && !hiddenAt) out += decode(text);
      continue;
    }
    const { hide } = tags;
    if (hide && name === hide.scope && !selfClose) {
      if (!close) depth++;
      else {
        if (hiddenAt === depth) hiddenAt = 0;
        depth = Math.max(0, depth - 1);
      }
    }
    if (hide && depth && !hiddenAt && !close && hide.mark(name, attrs)) hiddenAt = depth;
    if (tags.text.includes(name)) {
      if (!selfClose) inText = Math.max(0, inText + (close ? -1 : 1));
    } else if (hiddenAt) continue;
    else if (close && tags.para.includes(name)) out += '\n';
    else if (!close && tags.tab?.includes(name)) out += '\t';
    else if (!close && tags.br?.includes(name)) out += '\n';
  }
  return out;
}

// slide1.xml, slide2.xml, … 처럼 번호 붙은 항목을 번호순으로
const numbered = (names: string[], re: RegExp) =>
  names
    .map((n) => ({ n, i: Number(re.exec(n)?.[1]) }))
    .filter((x) => Number.isInteger(x.i))
    .sort((a, b) => a.i - b.i)
    .map((x) => x.n);

// 공유 문자열·셀을 토큰으로 훑는다 (정규식 [\s\S]*? 로 요소를 자르면 닫는 태그 없는 입력에서 제곱 시간)
function xlsxText(zip: ReturnType<typeof openZip>): string {
  const str = (name: string) => zip.read(name)?.toString('utf8') ?? '';
  // 공유 문자열: <si> 하나가 문자열 하나 (서식 조각 <r><t> 여럿일 수 있음)
  const shared: string[] = [];
  let cur = '';
  let inT = false;
  for (const [, close, name, , self, text] of str('xl/sharedStrings.xml').matchAll(TOKEN)) {
    if (text !== undefined) {
      if (inT) cur += decode(text);
    } else if (name === 't') inT = !close && !self;
    else if (name === 'si') {
      if (!close) cur = '';
      if (close || self) shared.push(cur);
    }
  }
  const sheets = numbered(zip.names, /^xl\/worksheets\/sheet(\d+)\.xml$/).map((name, i) => {
    const rows: string[] = [];
    let row: string[] | null = null;
    let cell = '';
    let type: string | undefined;
    let inV = false;
    for (const [, close, tag, attrs, self, text] of str(name).matchAll(TOKEN)) {
      if (text !== undefined) {
        if (inV) cell += decode(text);
      } else if (tag === 'row') {
        // 숨긴 행은 버린다 (숨김 글자 — 지시 숨김 통로 차단)
        if (!close && !self) row = /\bhidden="(1|true)"/.test(attrs) ? null : [];
        else if (close && row) {
          rows.push(row.join('\t'));
          row = null;
        }
      } else if (tag === 'c') {
        if (!close) {
          type = /\bt="(\w+)"/.exec(attrs)?.[1];
          cell = '';
        }
        if (close || self) row?.push(type === 's' ? (shared[Number(cell)] ?? '') : cell);
      } else if (tag === 'v' || tag === 't') inV = !close && !self;
    }
    return `## 시트 ${i + 1}\n${rows.join('\n')}`;
  });
  return sheets.join('\n\n');
}

// 믿을 수 없는 문서 → 평문. 메모리 안에서만 풀고(경로 이탈 없음), 외부 프로세스·네트워크를 쓰지 않는다
export function extractDocText(name: string, buf: Buffer): string {
  const ext = extname(name).toLowerCase();
  const budget = new Budget();
  if (ext === '.hwp') return hwpText(buf, budget).trim();
  const zip = openZip(buf, budget);
  const str = (n: string) => zip.read(n)?.toString('utf8') ?? '';
  let text: string;
  if (ext === '.docx')
    text = xmlText(str('word/document.xml'), {
      text: ['w:t'],
      para: ['w:p'],
      tab: ['w:tab'],
      br: ['w:br', 'w:cr'],
      // 숨김 글자(w:vanish) 런은 버린다. w:val="0|false" 는 숨김 해제
      hide: { scope: 'w:r', mark: (n, a) => n === 'w:vanish' && !/w:val="(0|false|off)"/.test(a) },
    });
  else if (ext === '.pptx')
    text = numbered(zip.names, /^ppt\/slides\/slide(\d+)\.xml$/)
      .map((n, i) => {
        const xml = str(n);
        // 숨긴 슬라이드(show="0")는 번호만 남기고 글은 버린다. 숨긴 도형(cNvPr hidden)도 버린다
        if (/<p:sld\b[^<>]*\bshow="(0|false)"/.test(xml)) return `## 슬라이드 ${i + 1}\n(숨긴 슬라이드)`;
        const hide: Hide = { scope: 'p:sp', mark: (t, a) => t === 'p:cNvPr' && /\bhidden="(1|true)"/.test(a) };
        return `## 슬라이드 ${i + 1}\n${xmlText(xml, { text: ['a:t'], para: ['a:p'], br: ['a:br'], hide }).trim()}`;
      })
      .join('\n\n');
  else if (ext === '.hwpx')
    text = numbered(zip.names, /^Contents\/section(\d+)\.xml$/)
      .map((n) =>
        xmlText(str(n), {
          text: ['hp:t'],
          para: ['hp:p'],
          tab: ['hp:tab'],
          br: ['hp:lineBreak'],
          // 숨은 설명은 화면에 안 보이는 글이라 버린다
          hide: { scope: 'hp:hiddenComment', mark: (t) => t === 'hp:hiddenComment' },
        })
      )
      .join('\n');
  else if (ext === '.xlsx') text = xlsxText(zip);
  else throw new Error(`${ext} 는 문서 형식이 아닙니다.`);
  return text.replace(/\n{3,}/g, '\n\n').trim();
}
