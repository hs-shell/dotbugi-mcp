// 임시 스텁 — #18(ASR 런타임 관리)이 실제 구현으로 바꾼다
export interface AsrRuntime {
  ffmpeg: string;
  kind: 'cpu' | 'gpu';
  // stdin 으로 16kHz mono s16le PCM 을 받아 stdout 에 받아쓴 글을 낸다
  command: string;
  args: string[];
  env?: Record<string, string>;
  model: '0.6b' | '1.7b';
}

export function resolveAsrRuntime(): Promise<AsrRuntime> {
  return Promise.reject(new Error('ASR 런타임이 설치되지 않았습니다 — dotbugi-mcp asr install'));
}
