import { describe, expect, it } from 'vitest';
import { ASSIGN_DIFF_MAX_CELLS } from '../constants.js';
import { unifiedDiff } from '../assign/diff.js';
import { instructionPart } from '../assign/instructions.js';

describe('unifiedDiff', () => {
  it('같으면 null', () => {
    expect(unifiedDiff('a\nb', 'a\nb')).toBeNull();
  });

  it('바뀐 줄만 -/+ 로, 앞뒤 3줄 문맥과 줄 번호를 붙인다', () => {
    const before = ['1', '2', '3', '4', '5', '기한 3월28일', '7', '8', '9', '10'].join('\n');
    const after = before.replace('기한 3월28일', '기한 4월2일');
    expect(unifiedDiff(before, after)).toBe(
      ['@@ -3,7 +3,7 @@', ' 3', ' 4', ' 5', '-기한 3월28일', '+기한 4월2일', ' 7', ' 8', ' 9'].join('\n')
    );
  });

  it('떨어진 변경은 묶음(hunk)을 나누고, 추가·삭제만 있는 경우도 표시한다', () => {
    const lines = Array.from({ length: 20 }, (_, i) => String(i + 1));
    const after = [...lines.slice(0, 1), ...lines.slice(2), '추가'].join('\n');
    const diff = unifiedDiff(lines.join('\n'), after) ?? '';
    expect(diff.match(/^@@/gm)).toHaveLength(2);
    expect(diff).toContain('-2');
    expect(diff).toContain('+추가');
  });

  it('비교 표가 상한을 넘으면 줄 비교를 생략하고 줄 수만 알린다', () => {
    const n = Math.ceil(Math.sqrt(ASSIGN_DIFF_MAX_CELLS)) + 1;
    const a = Array.from({ length: n }, (_, i) => `a${i}`).join('\n');
    const b = Array.from({ length: n }, (_, i) => `b${i}`).join('\n');
    expect(unifiedDiff(a, b)).toBe(`@@ 변경 범위가 커서 줄 비교를 생략했습니다 (이전 ${n}줄 → 새 ${n}줄) @@`);
  });
});

describe('instructionPart', () => {
  it('머리의 제출 상황 행과 받기 안내 절은 빼고, 본문 속 같은 모양의 줄은 남긴다', () => {
    const md = [
      '# 과제1',
      '- 마감: 2026-11-01',
      '- 제출 여부: 제출 안 함',
      '## 본문 지시사항 (LMS 과제 화면)',
      '- 제출 여부: 본문에 적힌 줄',
      '## dotbugi-mcp 안내',
      '- 시간 상한에 걸려…',
    ].join('\n');
    const part = instructionPart(md);
    expect(part).toContain('- 마감: 2026-11-01');
    expect(part).not.toContain('제출 안 함');
    expect(part).toContain('본문에 적힌 줄');
    expect(part).not.toContain('시간 상한');
  });
});
