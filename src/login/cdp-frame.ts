// --remote-debugging-pipe 의 메시지 경계: JSON 하나 뒤에 NUL(\0) 한 바이트.
// JSON.stringify 는 문자열 속 NUL 을 \u0000 으로 이스케이프하므로 본문에 NUL 이 섞이지 않는다
const DELIMITER = 0;

export function encodeFrame(message: object): string {
  return `${JSON.stringify(message)}\0`;
}

// 청크가 메시지 중간(또는 UTF-8 글자 중간)에서 잘려 와도 되도록 바이트 단위로 모았다가 NUL 에서 자른다
export function createFrameDecoder(onMessage: (raw: string) => void): (chunk: Buffer) => void {
  let pending = Buffer.alloc(0);
  return (chunk) => {
    pending = Buffer.concat([pending, chunk]);
    let end: number;
    while ((end = pending.indexOf(DELIMITER)) !== -1) {
      onMessage(pending.subarray(0, end).toString('utf8'));
      pending = pending.subarray(end + 1);
    }
  };
}
