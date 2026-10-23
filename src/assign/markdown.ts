import { LMS_ORIGIN } from '../constants.js';
import { clean } from '../tasks/text.js';

const SKIP = new Set(['script', 'style', 'noscript', 'template', 'iframe', 'object', 'embed', 'svg', 'form']);
const BLOCK = new Set(['p', 'div', 'section', 'article', 'blockquote', 'ul', 'ol', 'table', 'figure', 'hr']);
const ELEMENT_NODE = 1;
const TEXT_NODE = 3;
const HIDDEN_CLASSES = ['accesshide', 'sr-only', 'd-none', 'hidden', 'visually-hidden'];
const HIDDEN_STYLE =
  /display\s*:\s*none|visibility\s*:\s*hidden|(?:font-size|opacity)\s*:\s*0(?![.\d]*[1-9])|(?:left|text-indent)\s*:\s*-\d{3,}/i;

// 화면에 안 보이는 글은 사람 몰래 지시를 숨겨 넣는 통로가 되므로 버린다 (흔한 숨김 방식만 거르는 최선 노력)
const isHidden = (el: Element) =>
  el.hasAttribute('hidden') ||
  el.getAttribute('aria-hidden') === 'true' ||
  (el.getAttribute('class') ?? '').split(/\s+/).some((c) => HIDDEN_CLASSES.includes(c)) ||
  HIDDEN_STYLE.test(el.getAttribute('style') ?? '');

const looksLikeUrl = (text: string) => /^(https?:\/\/|www\.)|^[\w-]+(\.[\w-]+)+(\/\S*)?$/i.test(text);

// http(s) 링크만 주소를 남긴다 (javascript: 등은 글자만)
function link(href: string | null, text: string): string {
  const url = href ? URL.parse(href, LMS_ORIGIN) : null;
  if (!url || (url.protocol !== 'https:' && url.protocol !== 'http:')) return text;
  // URL 이 공백은 이미 인코딩한다. 괄호는 마크다운 링크를 끊으므로 직접 인코딩
  const target = url.href.replace(/\(/g, '%28').replace(/\)/g, '%29');
  const label = text.trim().replace(/[[\]]/g, '\\$&');
  if (!label) return `[${target}](${target})`;
  // 주소처럼 보이는 글자가 실제 주소와 다르면 진짜 주소를 드러낸다 (LMS 주소로 위장한 외부 링크)
  const shown = looksLikeUrl(text.trim()) && URL.parse(text.includes('://') ? text.trim() : `https://${text.trim()}`);
  if (shown && shown.href !== url.href) return `${label} (${target})`;
  return `[${label}](${target})`;
}

// <pre> 의 줄바꿈·들여쓰기는 살리되 제어(\n·\t 제외)·서식 문자는 지운다
const preText = (text: string) => text.replace(/\r\n?|[\u2028\u2029]/g, '\n').replace(/(?![\n\t])[\p{Cc}\p{Cf}]/gu, '');

function fenced(code: string): string {
  const longest = Math.max(0, ...Array.from(code.matchAll(/`+/g), (m) => m[0].length));
  const fence = '`'.repeat(Math.max(3, longest + 1));
  return `${fence}\n${code.replace(/^\n+|\n+$/g, '')}\n${fence}`;
}

// pre 블록은 줄 다듬기를 피하도록 자리표시(\0 — 본문 텍스트에는 남지 않는 문자)로 빼 두었다가 마지막에 넣는다
function convert(node: Node, blocks: string[], pre = false): string {
  if (node.nodeType === TEXT_NODE)
    // 줄바꿈은 구조에서만 만든다 — 텍스트 안의 공백·제어·서식 문자는 공백 하나로 접는다
    return pre ? preText(node.textContent ?? '') : (node.textContent ?? '').replace(/[\s\p{Cc}\p{Cf}]+/gu, ' ');
  if (node.nodeType !== ELEMENT_NODE) return '';
  const el = node as Element;
  const tag = el.tagName.toLowerCase();
  if (SKIP.has(tag) || isHidden(el)) return '';
  if (tag === 'br') return '\n';
  if (tag === 'img') {
    const alt = clean(el.getAttribute('alt') ?? '');
    return alt ? `[이미지: ${alt}]` : '';
  }
  const inner = Array.from(el.childNodes, (child) => convert(child, blocks, pre || tag === 'pre')).join('');
  if (tag === 'pre' && !pre) return `\n\n\0${blocks.push(fenced(inner)) - 1}\0\n\n`;
  if (pre) return inner;
  if (/^h[1-6]$/.test(tag)) return `\n\n${'#'.repeat(Number(tag[1]))} ${inner.trim()}\n\n`;
  if (tag === 'li') return `\n- ${inner.trim()}`;
  if (tag === 'tr') return `\n|${inner}`;
  if (tag === 'td' || tag === 'th') return ` ${inner.trim()} |`;
  if (tag === 'a') return link(el.getAttribute('href'), inner);
  return BLOCK.has(tag) ? `\n\n${inner}\n\n` : inner;
}

// LMS 본문 HTML → 간단한 마크다운 (문단·제목·목록·표·링크·코드 블록만)
export function htmlToMarkdown(root: Element): string {
  const blocks: string[] = [];
  return convert(root, blocks)
    .split('\n')
    .map((line) => line.trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .replace(/\0(\d+)\0/g, (_, i: string) => blocks[Number(i)]);
}
