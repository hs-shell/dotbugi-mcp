// 입력창 위 한 줄. tone 은 색 고르기용
export type BandLine = { text: string; tone: 'running' | 'done' | 'error' | 'stopped' };

declare module 'claude-code' {
  interface PluginState {
    dotbugi: { line: BandLine | null };
  }
}
