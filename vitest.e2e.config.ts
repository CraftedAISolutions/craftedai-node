import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['e2e/**/*.e2e.test.ts'],
    environment: 'node',
    // The steps share one core-api, one example app and one session: run in order.
    sequence: { concurrent: false },
    fileParallelism: false,
    testTimeout: 60_000,
  },
});
