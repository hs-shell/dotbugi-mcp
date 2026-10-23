// OS 키체인에 문자열 하나를 저장하는 최소 인터페이스
export interface Keychain {
  get(): Promise<string | null>;
  set(value: string): Promise<void>;
  // 지운 값이 있었으면 true
  delete(): Promise<boolean>;
}
