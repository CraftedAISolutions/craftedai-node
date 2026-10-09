import { defineConfig } from 'vitest/config';

// Own config: without it vitest would walk up and pick the library's (src/** and test/**).
export default defineConfig({
  test: { include: ['*.test.js'], environment: 'node' },
});
