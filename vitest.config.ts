import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    // test/ 는 src 밖(플러그인 등)의 순수 함수 테스트
    include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
  },
});
