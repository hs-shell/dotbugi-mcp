// LMS 텍스트는 데이터일 뿐이다 — 공백·제어문자·서식 문자(제로폭·방향 전환 등)를 공백 하나로 접어 평범한 한 줄로만 넘긴다
export const clean = (text: string) => text.replace(/[\s\p{Cc}\p{Cf}]+/gu, ' ').trim();

// 마크다운 표 칸 — LMS 텍스트 안의 | 를 이스케이프한다. \ 도 함께 해야 원문 \| 가 \\| 가 되어 칸을 쪼개지 않는다
export const cell = (text: string) => text.replace(/[\\|]/g, '\\$&');

// 채팅 강조용 인라인 코드 (채팅은 글자 색을 못 고르므로 강조색으로 보이는 코드 스팬을 쓴다).
// 값 안의 가장 긴 백틱 묶음보다 긴 펜스로 감싸고, 앞뒤가 백틱이면 공백을 끼워 스팬이 깨지지 않게 한다
export function code(text: string): string {
  const fence = '`'.repeat(Math.max(0, ...Array.from(text.matchAll(/`+/g), (m) => m[0].length)) + 1);
  const pad = /^`|`$/.test(text) ? ' ' : '';
  return `${fence}${pad}${text}${pad}${fence}`;
}
