import { defineConfig } from 'tsup';

export default defineConfig([
  {
    entry: { index: 'src/index.ts' },
    format: ['esm', 'cjs'],
    // tsup's dts step sets `baseUrl`, deprecated in TypeScript 6.
    dts: { compilerOptions: { ignoreDeprecations: '6.0' } },
    sourcemap: true,
    clean: true,
    target: 'node20',
    platform: 'node',
    splitting: false,
  },
]);
