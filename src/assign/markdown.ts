import { LMS_ORIGIN } from '../constants.js';
import { clean } from '../tasks/text.js';

const SKIP = new Set(['script', 'style', 'noscript', 'template', 'iframe', 'object', 'embed', 'svg', 'form']);
const BLOCK = new Set(['p', 'div', 'section', 'article', 'blockquote', 'ul', 'ol', 'table', 'pre', 'figure', 'hr']);
const ELEMENT_NODE = 1;
const TEXT_NODE = 3;

// 화면에 안 보이는 글은 사람 몰래 지시를 숨겨 넣는 통로가 되므로 버린다
const isHidden = (el: Element) =>
  el.hasAttribute('hidden') ||
  el.getAttribute('aria-hidden') === 'true' ||
  /display\s*:\s*none|visibility\s*:\s*hidden/i.test(el.getAttribute('style') ?? '');

// http(s) 링크만 주소를 남긴다 (javascript: 등은 글자만)
function link(href: string | null, text: string): string {
  const url = href ? URL.parse(href, LMS_ORIGIN) : null;
  if (!url || (url.protocol !== 'https:' && url.protocol !== 'http:')) return text;
  return `[${text.trim() || url.href}](${url.href})`;
}

function convert(node: Node): string {
  // 줄바꿈은 구조에서만 만든다 — 텍스트 안의 공백·제어·서식 문자는 공백 하나로 접는다
  if (node.nodeType === TEXT_NODE) return (node.textContent ?? '').replace(/[\s\p{Cc}\p{Cf}]+/gu, ' ');
  if (node.nodeType !== ELEMENT_NODE) return '';
  const el = node as Element;
  const tag = el.tagName.toLowerCase();
  if (SKIP.has(tag) || isHidden(el)) return '';
  if (tag === 'br') return '\n';
  if (tag === 'img') {
    const alt = clean(el.getAttribute('alt') ?? '');
    return alt ? `[이미지: ${alt}]` : '';
  }
  const inner = Array.from(el.childNodes, convert).join('');
  if (/^h[1-6]$/.test(tag)) return `\n\n${'#'.repeat(Number(tag[1]))} ${inner.trim()}\n\n`;
  if (tag === 'li') return `\n- ${inner.trim()}`;
  if (tag === 'tr') return `\n|${inner}`;
  if (tag === 'td' || tag === 'th') return ` ${inner.trim()} |`;
  if (tag === 'a') return link(el.getAttribute('href'), inner);
  return BLOCK.has(tag) ? `\n\n${inner}\n\n` : inner;
}

// LMS 본문 HTML → 간단한 마크다운 (문단·제목·목록·표·링크만)
export function htmlToMarkdown(root: Element): string {
  return convert(root)
    .split('\n')
    .map((line) => line.trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
