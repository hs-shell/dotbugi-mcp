const FINGERPRINT_LENGTH = 6;

// 확장 연결 창과 맞춰 보는 확인 코드 (hs-shell/dotbugi#168 과 같은 규칙: 앞 6자, 대문자, XXX-XXX).
// 눈으로 비교하는 용도일 뿐이고, 실제 검증은 전체 코드로 한다
export function codeFingerprint(code: string): string {
  const head = code.slice(0, FINGERPRINT_LENGTH).toUpperCase();
  return `${head.slice(0, FINGERPRINT_LENGTH / 2)}-${head.slice(FINGERPRINT_LENGTH / 2)}`;
}
