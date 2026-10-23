const MASK = '[REDACTED]';
// 세션 쿠키·연결 코드가 섞인 문자열(오류 메시지, URL)에서 값을 지운다
const PATTERNS = [/(MoodleSession=)[^;\s]+/g, /(dotbugi-connect=)\S+/g, /(sesskey=)[A-Za-z0-9]+/g];

// 출력 직전에 거치는 단일 마스킹 함수. secrets 로 넘긴 값은 어디에 있든 지운다
export function redact(text: string, secrets: readonly string[] = []): string {
  let out = text;
  for (const s of secrets) if (s) out = out.split(s).join(MASK);
  for (const p of PATTERNS) out = out.replace(p, `$1${MASK}`);
  return out;
}

// 영상 주소는 경로에 시간 제한 토큰이 있다 — 외부 프로그램 출력·오류를 남기기 전에 주소째 지운다
export const stripUrls = (text: string) => text.replace(/[a-z][a-z0-9+.-]*:\/\/\S+/gi, '[URL]');
