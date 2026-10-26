import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    // test/ 는 src 밖(플러그인 등)의 순수 함수 테스트
    include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
    // `npm run test:coverage` 때만 수집. json-summary 는 PR 커버리지 댓글이 읽는다
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts', 'src/__tests__/**'],
      reporter: ['text', 'json-summary'],
    },
  },
});
