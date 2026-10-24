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

// 태그를 한 줄로 훑어 글자 태그 안의 글만 모은다 (DOM 을 만들지 않아 큰 문서도 선형)
// text: 글자가 든 태그, para: 끝나면 줄바꿈하는 태그, tab·br: 빈 태그로 쓰이는 탭·줄바꿈
function xmlText(xml: string, tags: { text: string[]; para: string[]; tab?: string[]; br?: string[] }): string {
  let out = '';
  let inText = 0;
  for (const m of xml.matchAll(/<(\/?)([\w:.-]+)[^>]*?(\/?)>|([^<]+)/g)) {
    const [, close, name, selfClose, text] = m;
    if (text !== undefined) {
      if (inText) out += decode(text);
      continue;
    }
    if (tags.text.includes(name)) {
      if (!selfClose) inText += close ? -1 : 1;
    } else if (close && tags.para.includes(name)) out += '\n';
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

function xlsxText(zip: ReturnType<typeof openZip>): string {
  const str = (name: string) => zip.read(name)?.toString('utf8') ?? '';
  // 공유 문자열: <si> 하나가 문자열 하나 (서식 조각 <r><t> 여럿일 수 있음)
  const shared = Array.from(str('xl/sharedStrings.xml').matchAll(/<si>([\s\S]*?)<\/si>/g), (m) =>
    xmlText(m[1], { text: ['t'], para: [] })
  );
  const sheets = numbered(zip.names, /^xl\/worksheets\/sheet(\d+)\.xml$/).map((name, i) => {
    const rows = Array.from(str(name).matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g), (row) =>
      Array.from(row[1].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g), ([, attrs, body = '']) => {
        const type = /\bt="(\w+)"/.exec(attrs)?.[1];
        if (type === 'inlineStr') return xmlText(body, { text: ['t'], para: [] });
        const v = decode(/<v>([\s\S]*?)<\/v>/.exec(body)?.[1] ?? '');
        return type === 's' ? (shared[Number(v)] ?? '') : v;
      }).join('\t')
    );
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
    text = xmlText(str('word/document.xml'), { text: ['w:t'], para: ['w:p'], tab: ['w:tab'], br: ['w:br', 'w:cr'] });
  else if (ext === '.pptx')
    text = numbered(zip.names, /^ppt\/slides\/slide(\d+)\.xml$/)
      .map((n, i) => `## 슬라이드 ${i + 1}\n${xmlText(str(n), { text: ['a:t'], para: ['a:p'], br: ['a:br'] }).trim()}`)
      .join('\n\n');
  else if (ext === '.hwpx')
    text = numbered(zip.names, /^Contents\/section(\d+)\.xml$/)
      .map((n) => xmlText(str(n), { text: ['hp:t'], para: ['hp:p'], tab: ['hp:tab'], br: ['hp:lineBreak'] }))
      .join('\n');
  else if (ext === '.xlsx') text = xlsxText(zip);
  else throw new Error(`${ext} 는 문서 형식이 아닙니다.`);
  return text.replace(/\n{3,}/g, '\n\n').trim();
}
