import { DOMParser } from 'linkedom';
import { describe, expect, it } from 'vitest';
import { htmlToMarkdown } from '../assign/markdown.js';

const md = (html: string) =>
  htmlToMarkdown(
    (
      new DOMParser().parseFromString(
        `<html><body><div id="r">${html}</div></body></html>`,
        'text/html'
      ) as unknown as Document
    ).getElementById('r')!
  );

describe('htmlToMarkdown', () => {
  it.each([
    '<span class="accesshide">숨김</span>',
    '<span class="x sr-only">숨김</span>',
    '<span class="d-none">숨김</span>',
    '<span class="hidden">숨김</span>',
    '<span class="visually-hidden">숨김</span>',
    '<span style="font-size:0">숨김</span>',
    '<span style="font-size: 0px">숨김</span>',
    '<span style="opacity:0">숨김</span>',
    '<span style="position:absolute; left:-9999px">숨김</span>',
    '<span style="text-indent: -1000em">숨김</span>',
  ])('흔한 숨김 처리 글은 버린다: %s', (hidden) => {
    expect(md(`<p>보임${hidden}</p>`)).toBe('보임');
  });

  it('보이는 스타일은 남긴다', () => {
    expect(md('<span style="font-size:0.9em; opacity:0.5; left:-10px">보임</span>')).toBe('보임');
  });

  it('링크 글자의 대괄호를 이스케이프하고 주소의 괄호를 인코딩한다', () => {
    expect(md('<a href="https://example.com/a(b)">자료 [1]</a>')).toBe('[자료 \\[1\\]](https://example.com/a%28b%29)');
  });

  it('주소처럼 보이는 글자가 실제 주소와 다르면 진짜 주소를 드러낸다', () => {
    expect(md('<a href="https://evil.example/x">https://learn.hansung.ac.kr/mod/assign/view.php?id=5</a>')).toBe(
      'https://learn.hansung.ac.kr/mod/assign/view.php?id=5 (https://evil.example/x)'
    );
    expect(md('<a href="https://evil.example/">learn.hansung.ac.kr</a>')).toBe(
      'learn.hansung.ac.kr (https://evil.example/)'
    );
    expect(md('<a href="https://example.com/ref">https://example.com/ref</a>')).toBe(
      '[https://example.com/ref](https://example.com/ref)'
    );
  });

  it('<pre> 는 줄바꿈·들여쓰기를 살린 코드 블록으로, 안의 ``` 보다 긴 펜스를 쓴다', () => {
    const out = md('<p>예시</p><pre>int main() {\n    return 0;​\u0007\n}\n```끝```</pre><p>다음</p>');
    expect(out).toBe('예시\n\n````\nint main() {\n    return 0;\n}\n```끝```\n````\n\n다음');
  });
});
