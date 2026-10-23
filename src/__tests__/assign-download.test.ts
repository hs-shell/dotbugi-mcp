import { describe, expect, it } from 'vitest';
import { attachmentName, safeFileName } from '../assign/download.js';

describe('safeFileName', () => {
  it.each([
    ['../../etc/passwd', '_.._etc_passwd'],
    ['..', 'attachment'],
    ['..\\..\\boot.ini', '_.._boot.ini'],
    ['C:\\Windows\\x.dll', 'C__Windows_x.dll'],
    ['.bashrc', 'bashrc'],
    ['CON.txt', '_CON.txt'],
    ['과제\u202Efdp.exe', '과제_fdp.exe'],
    ['a\nb\u0000c.pdf', 'a_b_c.pdf'],
    ['보고서 양식.hwp ', '보고서 양식.hwp'],
  ])('%j → %j', (raw, safe) => {
    expect(safeFileName(raw)).toBe(safe);
  });

  it('긴 이름은 확장자를 남기고 줄인다', () => {
    const name = safeFileName(`${'가'.repeat(200)}.pdf`);
    expect(name).toBe(`${'가'.repeat(60)}.pdf`);
    expect(Buffer.byteLength(name)).toBeLessThan(255);
  });
});

describe('attachmentName', () => {
  it('인코딩된 경로 문자도 풀어서 지운다', () => {
    const url = new URL('https://learn.hansung.ac.kr/pluginfile.php/1/mod_assign/introattachment/0/..%2F..%2Fevil.sh');
    expect(attachmentName(url)).toBe('_.._evil.sh');
    expect(attachmentName(new URL('https://learn.hansung.ac.kr/pluginfile.php/1/a/%E0%A4%A.pdf'))).toBe('%E0%A4%A.pdf');
  });
});
