// LMS 텍스트는 데이터일 뿐이다 — 공백·제어문자·서식 문자(제로폭·방향 전환 등)를 공백 하나로 접어 평범한 한 줄로만 넘긴다
export const clean = (text: string) => text.replace(/[\s\p{Cc}\p{Cf}]+/gu, ' ').trim();

// 마크다운 표 칸 — LMS 텍스트 안의 | 를 이스케이프한다. \ 도 함께 해야 원문 \| 가 \\| 가 되어 칸을 쪼개지 않는다
export const cell = (text: string) => text.replace(/[\\|]/g, '\\$&');
