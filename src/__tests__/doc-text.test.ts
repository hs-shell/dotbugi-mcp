import { describe, expect, it, vi } from 'vitest';
import { extractDocText } from '../doctext/extract.js';
import { hwp, paraText, zip } from './fixtures/docs.js';

vi.mock('../constants.js', async (orig) => ({
  ...(await orig<object>()),
  DOC_TEXT_MAX_INFLATED_BYTES: 1024 * 1024,
  DOC_TEXT_MAX_ENTRIES: 50,
}));

describe('extractDocText — 오피스·hwpx (zip+XML)', () => {
  it('docx: 문단·탭·줄바꿈·엔티티', () => {
    const xml =
      '<w:document><w:body><w:p><w:r><w:t>1. 문제 &amp; 답</w:t><w:tab/><w:t xml:space="preserve">교재 79쪽</w:t></w:r></w:p>' +
      '<w:p><w:r><w:t>제출 &lt;hwp&gt;</w:t><w:br/><w:t>&#54620;&#xAE00;</w:t></w:r></w:p></w:body></w:document>';
    expect(extractDocText('a.docx', zip({ 'word/document.xml': xml }))).toBe(
      '1. 문제 & 답\t교재 79쪽\n제출 <hwp>\n한글'
    );
  });

  it('pptx: 슬라이드를 번호순으로 (slide10 이 slide2 뒤)', () => {
    const slide = (t: string) => `<p:sld><a:p><a:r><a:t>${t}</a:t></a:r></a:p></p:sld>`;
    const text = extractDocText(
      'a.pptx',
      zip({
        'ppt/slides/slide10.xml': slide('열'),
        'ppt/slides/slide2.xml': slide('둘'),
        'ppt/slides/slide1.xml': slide('하나'),
      })
    );
    expect(text).toBe('## 슬라이드 1\n하나\n\n## 슬라이드 2\n둘\n\n## 슬라이드 3\n열');
  });

  it('xlsx: 공유 문자열·인라인 문자열·숫자를 탭으로', () => {
    const text = extractDocText(
      'a.xlsx',
      zip({
        'xl/sharedStrings.xml': '<sst><si><t>학번</t></si><si><r><t>이</t></r><r><t>름</t></r></si></sst>',
        'xl/worksheets/sheet1.xml':
          '<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>' +
          '<row r="2"><c r="A2"><v>42</v></c><c r="B2" t="inlineStr"><is><t>홍길동</t></is></c><c r="C2"/></row></sheetData></worksheet>',
      })
    );
    expect(text).toBe('## 시트 1\n학번\t이름\n42\t홍길동');
  });

  it('hwpx: 섹션 순서대로', () => {
    const sec = (t: string) => `<hs:sec><hp:p><hp:run><hp:t>${t}</hp:t></hp:run></hp:p></hs:sec>`;
    expect(
      extractDocText('a.hwpx', zip({ 'Contents/section1.xml': sec('둘'), 'Contents/section0.xml': sec('하나') }))
    ).toBe('하나\n\n둘');
  });

  it('zip bomb: 풀린 크기가 상한을 넘으면 멈춘다 (선언 크기는 믿지 않음)', () => {
    expect(() => extractDocText('a.docx', zip({ 'word/document.xml': Buffer.alloc(2 * 1024 * 1024) }))).toThrow(
      '너무 커서'
    );
  });

  it('항목이 너무 많거나, 암호화됐거나, zip 이 아니면 거부한다', () => {
    const many = Object.fromEntries(Array.from({ length: 51 }, (_, i) => [`f${i}`, 'x']));
    expect(() => extractDocText('a.docx', zip(many))).toThrow('항목이 너무 많아');
    expect(() => extractDocText('a.docx', zip({ 'word/document.xml': '<w:t>x</w:t>' }, 1))).toThrow('암호');
    expect(() => extractDocText('a.docx', Buffer.from('not a zip'))).toThrow('zip 형식이 아닙니다');
  });
});

describe('extractDocText — 구형 hwp', () => {
  it('압축된 본문: 문단 글자만, 표·그림 같은 8글자 제어는 건너뛰고 빈칸 제어는 빈칸', () => {
    const doc = hwp([
      [
        paraText({ ctrl: 2, wide: true }, 'Report#1 관계대수', { ctrl: 13 }),
        paraText('1.', { ctrl: 31 }, '문제', { ctrl: 11, wide: true }, ' 11번', { ctrl: 13 }),
      ],
      [paraText('제출', { ctrl: 10 }, '기한', { ctrl: 9, wide: true }, '3/28', { ctrl: 13 })],
    ]);
    expect(extractDocText('a.hwp', doc)).toBe('Report#1 관계대수\n1. 문제 11번\n\n제출\n기한\t3/28');
  });

  it('압축하지 않은 본문도 읽는다', () => {
    expect(extractDocText('a.HWP', hwp([[paraText('평문', { ctrl: 13 })]], 0))).toBe('평문');
  });

  it('암호·배포용 문서, hwp 가 아닌 파일은 거부한다', () => {
    expect(() => extractDocText('a.hwp', hwp([[paraText('x')]], 1 | 2))).toThrow('암호');
    expect(() => extractDocText('a.hwp', hwp([[paraText('x')]], 1 | 4))).toThrow('배포용');
    expect(() => extractDocText('a.hwp', Buffer.alloc(1024))).toThrow('hwp');
  });

  it('본문을 풀면 상한을 넘는 문서는 멈춘다', () => {
    expect(() => extractDocText('a.hwp', hwp([[Buffer.alloc(2 * 1024 * 1024)]]))).toThrow('너무 커서');
  });
});
