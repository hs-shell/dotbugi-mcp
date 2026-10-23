// LMS 텍스트는 데이터일 뿐이다 — 공백·제어문자·서식 문자(제로폭·방향 전환 등)를 공백 하나로 접어 평범한 한 줄로만 넘긴다
export const clean = (text: string) => text.replace(/[\s\p{Cc}\p{Cf}]+/gu, ' ').trim();
