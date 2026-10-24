import { DOC_TEXT_MAX_INFLATED_BYTES, DOC_TEXT_TIMEOUT_MS } from '../constants.js';

// 문서 하나를 푸는 동안 쓸 수 있는 압축 해제 총량·시간. 넘으면 바로 멈춘다
export class Budget {
  private left = DOC_TEXT_MAX_INFLATED_BYTES;
  private readonly deadline = Date.now() + DOC_TEXT_TIMEOUT_MS;

  // 이번에 풀 수 있는 최대 바이트 (inflate 의 maxOutputLength 로 넘긴다)
  get remaining(): number {
    this.check();
    return this.left;
  }

  spend(n: number): void {
    this.left -= n;
    this.check();
  }

  check(): void {
    if (this.left < 0) throw new Error('문서를 풀면 너무 커서 읽지 않았습니다.');
    if (Date.now() > this.deadline) throw new Error('문서를 읽는 데 너무 오래 걸려 멈췄습니다.');
  }
}
