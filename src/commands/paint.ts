import { styleText } from 'node:util';

// 터미널 명령 공통 색. 안내(log)는 stderr 로 가므로 그 스트림이 터미널이고 NO_COLOR 가 없을 때만 칠한다 (파이프면 평문)
export const paint = (
  format: Parameters<typeof styleText>[0],
  text: string,
  stream: NodeJS.WriteStream = process.stderr
) => styleText(format, text, { stream });
