import { ASSIGN_DIFF_CONTEXT_LINES as CONTEXT, ASSIGN_DIFF_MAX_CELLS as MAX_CELLS } from '../constants.js';

type Op = { t: ' ' | '-' | '+'; line: string };

// 공통 앞뒤를 떼고 가운데만 LCS 로 비교한다 — 지시사항 수정은 보통 몇 줄이라 표가 작다
function lineOps(a: string[], b: string[]): Op[] | null {
  let p = 0;
  while (p < a.length && p < b.length && a[p] === b[p]) p++;
  let s = 0;
  while (s < a.length - p && s < b.length - p && a[a.length - 1 - s] === b[b.length - 1 - s]) s++;
  const x = a.slice(p, a.length - s);
  const y = b.slice(p, b.length - s);
  // O(n·m) 표가 상한을 넘으면 줄 비교를 하지 않는다 (첨부 글자 전체가 바뀐 경우 등)
  if ((x.length + 1) * (y.length + 1) > MAX_CELLS) return null;
  const w = y.length + 1;
  const lcs = new Uint32Array((x.length + 1) * w);
  for (let i = x.length - 1; i >= 0; i--)
    for (let j = y.length - 1; j >= 0; j--)
      lcs[i * w + j] =
        x[i] === y[j] ? lcs[(i + 1) * w + j + 1] + 1 : Math.max(lcs[(i + 1) * w + j], lcs[i * w + j + 1]);
  const mid: Op[] = [];
  let i = 0;
  let j = 0;
  // 비기면 삭제를 먼저 — 관례대로 -줄 다음에 +줄
  while (i < x.length || j < y.length) {
    if (i < x.length && j < y.length && x[i] === y[j]) {
      mid.push({ t: ' ', line: x[i++] });
      j++;
    } else if (i === x.length || (j < y.length && lcs[i * w + j + 1] > lcs[(i + 1) * w + j]))
      mid.push({ t: '+', line: y[j++] });
    else mid.push({ t: '-', line: x[i++] });
  }
  const same = (lines: string[]) => lines.map((line): Op => ({ t: ' ', line }));
  return [...same(a.slice(0, p)), ...mid, ...same(a.slice(a.length - s))];
}

// 두 글의 줄 단위 unified diff (앞뒤 문맥 CONTEXT 줄). 같으면 null
export function unifiedDiff(before: string, after: string): string | null {
  if (before === after) return null;
  const a = before.split('\n');
  const b = after.split('\n');
  const ops = lineOps(a, b);
  if (!ops) return `@@ 변경 범위가 커서 줄 비교를 생략했습니다 (이전 ${a.length}줄 → 새 ${b.length}줄) @@`;
  const changed = ops.flatMap((o, k) => (o.t === ' ' ? [] : [k]));
  const out: string[] = [];
  for (let g = 0; g < changed.length;) {
    // 문맥이 겹치는 변경은 한 묶음(hunk)으로
    let h = g;
    while (h + 1 < changed.length && changed[h + 1] - changed[h] <= CONTEXT * 2) h++;
    const lo = Math.max(0, changed[g] - CONTEXT);
    const hi = Math.min(ops.length, changed[h] + CONTEXT + 1);
    const before = ops.slice(0, lo);
    const part = ops.slice(lo, hi);
    const count = (list: Op[], t: Op['t']) => list.filter((o) => o.t === ' ' || o.t === t).length;
    const aLen = count(part, '-');
    const bLen = count(part, '+');
    out.push(`@@ -${count(before, '-') + (aLen ? 1 : 0)},${aLen} +${count(before, '+') + (bLen ? 1 : 0)},${bLen} @@`);
    out.push(...part.map((o) => o.t + o.line));
    g = h + 1;
  }
  return out.join('\n');
}
