import { describe, expect, it, vi } from 'vitest';
import { extractDoc, extractDocText } from '../doctext/extract.js';
import { imageMime } from '../doctext/images.js';
import { hwp, jpg, paraText, png, pptx, record, zip } from './fixtures/docs.js';

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

describe('extractDocText — 숨김 글자는 버린다 (지시 숨김 통로)', () => {
  it('docx: w:vanish 런은 빼고, w:val="0" 은 보인다', () => {
    const run = (t: string, rpr = '') => `<w:r>${rpr ? `<w:rPr>${rpr}</w:rPr>` : ''}<w:t>${t}</w:t></w:r>`;
    const xml = `<w:body><w:p>${run('보임')}${run('숨김', '<w:vanish/>')}${run('해제', '<w:vanish w:val="0"/>')}</w:p></w:body>`;
    expect(extractDocText('a.docx', zip({ 'word/document.xml': xml }))).toBe('보임해제');
  });

  it('pptx: 숨긴 슬라이드·숨긴 도형의 글은 빼고 번호는 유지', () => {
    const sp = (t: string, hidden = '') =>
      `<p:sp><p:nvSpPr><p:cNvPr id="2" name="x"${hidden}/></p:nvSpPr><p:txBody><a:p><a:r><a:t>${t}</a:t></a:r></a:p></p:txBody></p:sp>`;
    const text = extractDocText(
      'a.pptx',
      zip({
        'ppt/slides/slide1.xml': `<p:sld>${sp('보임')}${sp('숨김', ' hidden="1"')}</p:sld>`,
        'ppt/slides/slide2.xml': `<p:sld show="0">${sp('숨긴 슬라이드 글')}</p:sld>`,
      })
    );
    expect(text).toBe('## 슬라이드 1\n보임\n\n## 슬라이드 2\n(숨긴 슬라이드)');
  });

  it('xlsx: 숨긴 행은 뺀다', () => {
    const sheet =
      '<sheetData><row r="1"><c t="inlineStr"><is><t>보임</t></is></c></row>' +
      '<row r="2" hidden="1"><c t="inlineStr"><is><t>숨김</t></is></c></row></sheetData>';
    expect(extractDocText('a.xlsx', zip({ 'xl/worksheets/sheet1.xml': sheet }))).toBe('## 시트 1\n보임');
  });

  it('hwpx: 숨은 설명은 뺀다', () => {
    const sec =
      '<hs:sec><hp:p><hp:run><hp:t>보임</hp:t><hp:ctrl><hp:hiddenComment><hp:subList><hp:p><hp:run><hp:t>숨김</hp:t></hp:run></hp:p></hp:subList></hp:hiddenComment></hp:ctrl></hp:run></hp:p></hs:sec>';
    expect(extractDocText('a.hwpx', zip({ 'Contents/section0.xml': sec }))).toBe('보임');
  });

  it('hwp: 숨은 설명(tcmt) 컨트롤 아래 문단은 뺀다', () => {
    const tcmt = Buffer.alloc(4);
    tcmt.writeUInt32LE(0x74636d74);
    const hidden = paraText('숨김', { ctrl: 13 }).subarray(4);
    const doc = hwp([
      [paraText('보임', { ctrl: 13 }), record(71, tcmt, 1), record(67, hidden, 2), paraText('끝', { ctrl: 13 })],
    ]);
    expect(extractDocText('a.hwp', doc)).toBe('보임\n끝');
  });
});

describe('extractDocText — 악성 입력', () => {
  it('닫히지 않은 태그가 이어져도 선형 시간 (ReDoS)', () => {
    const t = Date.now();
    extractDocText('a.docx', zip({ 'word/document.xml': '<w:t<'.repeat(150_000) + 'a'.repeat(100_000) }));
    extractDocText(
      'a.xlsx',
      zip({ 'xl/sharedStrings.xml': '<si>'.repeat(100_000), 'xl/worksheets/sheet1.xml': '<row<c'.repeat(80_000) })
    );
    expect(Date.now() - t).toBeLessThan(2000);
  });

  it('hwp: FAT 섹터 수를 부풀려 채우기 크기를 키우면 할당 전에 멈춘다', () => {
    const doc = hwp([[paraText('x')]]);
    doc.writeUInt32LE(0x7fffffff, 44);
    expect(() => extractDocText('a.hwp', doc)).toThrow('너무 커서');
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

describe('extractDoc — 문서 안 그림 목록', () => {
  const list = (name: string, buf: Buffer) => extractDoc(name, buf).images.map((x) => `${x.label}:${x.entry}`);

  it('pptx: 슬라이드 순서·슬라이드 안 r:embed 순서, 같은 그림은 처음 한 번만, 숨긴 슬라이드·외부 링크·밖 경로는 뺀다', () => {
    const buf = pptx(
      [
        ['일', ['b.png', 'a.png']],
        ['이', ['a.png', 'c.jpg']],
      ],
      { 'a.png': png('a'), 'b.png': png('b'), 'c.jpg': jpg('c') }
    );
    expect(list('a.pptx', buf)).toEqual([
      '슬라이드 1:ppt/media/b.png',
      '슬라이드 1:ppt/media/a.png',
      '슬라이드 2:ppt/media/c.jpg',
    ]);
    const tricky = zip({
      'ppt/slides/slide1.xml': '<p:sld show="0"><a:blip r:embed="rId1"/></p:sld>',
      'ppt/slides/_rels/slide1.xml.rels': '<Relationship Id="rId1" Target="../media/a.png"/>',
      'ppt/slides/slide2.xml':
        '<p:sld><a:blip r:embed="rId1"/><a:blip r:embed="rId2"/><a:blip r:embed="rId3"/></p:sld>',
      'ppt/slides/_rels/slide2.xml.rels':
        '<Relationship Id="rId1" Target="http://evil/x.png" TargetMode="External"/>' +
        '<Relationship Id="rId2" Target="../../../secret.png"/><Relationship Id="rId3" Target="../slides/slide1.xml"/>',
      'ppt/media/a.png': png('a'),
    });
    expect(list('a.pptx', tricky)).toEqual([]);
  });

  it('docx: 본문 순서, hwpx: 구역 순서와 content.hpf 의 href', () => {
    const docx = zip({
      'word/document.xml': '<w:p><w:t>글</w:t><a:blip r:embed="rId9"/><a:blip r:embed="rId2"/></w:p>',
      'word/_rels/document.xml.rels':
        '<Relationship Id="rId2" Target="media/image1.png"/><Relationship Id="rId9" Target="media/image2.jpeg"/>',
    });
    expect(list('a.docx', docx)).toEqual(['본문:word/media/image2.jpeg', '본문:word/media/image1.png']);
    const hwpx = zip({
      'Contents/content.hpf':
        '<opf:item id="image1" href="BinData/image1.png"/><opf:item id="image2" href="BinData/../x.png"/><opf:item id="image3" href="BinData/image3.bmp"/>',
      'Contents/section0.xml': '<hp:p><hp:t>글</hp:t><hc:img binaryItemIDRef="image3"/></hp:p>',
      'Contents/section1.xml': '<hc:img binaryItemIDRef="image1"/><hc:img binaryItemIDRef="image2"/>',
    });
    expect(list('a.hwpx', hwpx)).toEqual(['구역 1:BinData/image3.bmp', '구역 2:BinData/image1.png']);
  });

  it('구형 hwp 는 그림 개수만 센다', () => {
    expect(extractDoc('a.hwp', hwp([[paraText('x')]], 1, 2)).hwpImages).toBe(2);
  });

  it('형식은 앞 바이트로만 정한다 (png·jpg·gif)', () => {
    expect(imageMime(png('x'))).toBe('image/png');
    expect(imageMime(jpg('x'))).toBe('image/jpeg');
    expect(imageMime(Buffer.from('GIF89a...'))).toBe('image/gif');
    expect(imageMime(Buffer.from('<svg>'))).toBeNull();
    expect(imageMime(Buffer.from([0x01, 0, 0, 0]))).toBeNull(); // emf
  });
});
