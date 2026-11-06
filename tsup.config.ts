import { defineConfig } from 'tsup';

// `dist` is emptied by the `prebuild` script, not by `clean`: the two configs build in
// parallel, and one cleaning the output directory could delete the other's files.
export default defineConfig([
  {
    entry: { index: 'src/index.ts' },
    format: ['esm', 'cjs'],
    // tsup's dts step sets `baseUrl`, deprecated in TypeScript 6.
    dts: { compilerOptions: { ignoreDeprecations: '6.0' } },
    sourcemap: true,
    clean: false,
    target: 'node20',
    platform: 'node',
    splitting: false,
  },
  {
    // `npx craftedai init`: ESM only, no types (it is a program, not an import).
    entry: { cli: 'src/cli/main.ts' },
    format: ['esm'],
    sourcemap: true,
    clean: false,
    target: 'node20',
    platform: 'node',
    splitting: false,
    banner: { js: '#!/usr/bin/env node' },
  },
]);
