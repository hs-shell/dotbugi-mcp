import { DOMParser } from 'linkedom';
import { describe, expect, it } from 'vitest';
import { isLmsFileUrl, parseAssignPage } from '../assign/page.js';

const L = 'https://learn.hansung.ac.kr';
const doc = (html: string) => new DOMParser().parseFromString(html, 'text/html') as unknown as Document;

describe('isLmsFileUrl', () => {
  it.each([
    [`${L}/pluginfile.php/1/mod_assign/intro/a.pdf`, true],
    [`${L}/pluginfile.php/1/a.pdf?forcedownload=1`, true],
    [`${L}/mod/assign/view.php?id=1`, false],
    [`${L}/pluginfile.phpx/1/a.pdf`, false],
    ['http://learn.hansung.ac.kr/pluginfile.php/1/a.pdf', false],
    ['https://evil.example/pluginfile.php/1/a.pdf', false],
    ['https://learn.hansung.ac.kr.evil.example/pluginfile.php/1/a.pdf', false],
    ['https://u:p@learn.hansung.ac.kr/pluginfile.php/1/a.pdf', false],
    ['https://learn.hansung.ac.kr:8443/pluginfile.php/1/a.pdf', false],
  ])('%s → %s', (url, expected) => {
    expect(isLmsFileUrl(new URL(url))).toBe(expected);
  });
});

describe('parseAssignPage', () => {
  it('제목·제출 상황·마감·본문·LMS 첨부만 (같은 파일은 한 번)', () => {
    const page = parseAssignPage(
      doc(`<body><nav><h2>메뉴</h2></nav><div role="main">
        <h2>  과제
          1 </h2>
        <div id="intro"><p>보고서를 <strong>제출</strong>하세요.</p>
          <a href="/pluginfile.php/9/mod_assign/intro/guide.pdf">안내</a>
          <a href="${L}/pluginfile.php/9/mod_assign/intro/guide.pdf?forcedownload=1">다시</a>
          <a href="https://evil.example/pluginfile.php/9/x.pdf">외부</a>
          <a href="/mod/forum/view.php?id=3">게시판</a>
        </div>
        <table class="submissionstatustable">
          <tr><th>제출 여부</th><td>제출 안 함</td></tr>
          <tr><td>종료 일시</td><td>2026-10-25 18:00</td></tr>
          <tr><td>칸 하나</td></tr>
          <tr><th>남은 기한</th><td>무시</td><td>1일 6시간</td></tr>
        </table></div></body>`)
    );
    expect(page.title).toBe('과제 1');
    expect(page.status).toEqual([
      { label: '제출 여부', value: '제출 안 함' },
      { label: '종료 일시', value: '2026-10-25 18:00' },
      { label: '남은 기한', value: '1일 6시간' },
    ]);
    expect(page.deadline).toBe('2026-10-25T18:00:00+09:00');
    expect(page.body).toContain('보고서를 제출하세요.');
    expect(page.attachmentUrls.map(String)).toEqual([`${L}/pluginfile.php/9/mod_assign/intro/guide.pdf`]);
  });

  it('영문 화면의 Due date 도 마감으로 읽고, 본문이 없으면 빈 값', () => {
    const page = parseAssignPage(
      doc(`<div role="main"><h2>Essay</h2><table class="submissionstatustable">
        <tr><th>Due date</th><td>2026-11-01 23:59</td></tr></table></div>`)
    );
    expect(page.deadline).toBe('2026-11-01T23:59:00+09:00');
    expect(page.body).toBe('');
    expect(page.attachmentUrls).toEqual([]);
  });

  it('마감 행이 없으면 null', () => {
    expect(parseAssignPage(doc('<div role="main"><h2>과제</h2></div>')).deadline).toBeNull();
  });

  it('role="main" 이 없으면 body 에서 찾는다', () => {
    expect(parseAssignPage(doc('<html><body><h2>과제</h2></body></html>')).title).toBe('과제');
  });

  it.each(['<div role="main"><p>과제 아님</p></div>', '<div role="main"><h2>  </h2></div>'])(
    '제목이 없으면 과제 화면이 아니라는 오류: %s',
    (html) => {
      expect(() => parseAssignPage(doc(html))).toThrow('과제 화면을 읽지 못했습니다');
    }
  );
});
