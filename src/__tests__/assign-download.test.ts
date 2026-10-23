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
    ['nul .txt', '_nul.txt'],
    ['CON .tar.gz', '_CON .tar.gz'],
    ['CONIN$', '_CONIN$'],
    ['conout$.log', '_conout$.log'],
    ['COM¹.txt', '_COM¹.txt'],
    ['LPT³', '_LPT³'],
    ['COM10.txt', 'COM10.txt'],
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

  it('확장자 없는 이름은 자른 뒤 끝의 점·공백을 지운다', () => {
    expect(safeFileName(`${'가'.repeat(59)}. 나머지`)).toBe('가'.repeat(59));
  });
});

describe('attachmentName', () => {
  it('인코딩된 경로 문자도 풀어서 지운다', () => {
    const url = new URL('https://learn.hansung.ac.kr/pluginfile.php/1/mod_assign/introattachment/0/..%2F..%2Fevil.sh');
    expect(attachmentName(url)).toBe('_.._evil.sh');
    expect(attachmentName(new URL('https://learn.hansung.ac.kr/pluginfile.php/1/a/%E0%A4%A.pdf'))).toBe('%E0%A4%A.pdf');
  });
});
