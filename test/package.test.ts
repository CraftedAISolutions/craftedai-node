import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
  name: string;
  engines: { node: string };
  dependencies: Record<string, string>;
  exports: Record<string, unknown>;
};

describe('package (spec §8)', () => {
  it('is @craftedai/node with exactly one runtime dependency: jose', () => {
    expect(pkg.name).toBe('@craftedai/node');
    expect(Object.keys(pkg.dependencies)).toEqual(['jose']);
  });

  it('requires a Node that can require() an ESM-only jose from the CJS build', () => {
    expect(pkg.engines.node).toBe('>=20.19.0');
  });

  it('lists the types condition first in both export conditions', () => {
    const conditions = pkg.exports['.'] as Record<string, Record<string, string>>;
    expect(Object.keys(conditions.import!)[0]).toBe('types');
    expect(Object.keys(conditions.require!)[0]).toBe('types');
  });

  it('ships ESM and CJS entry points with types', () => {
    expect(pkg.exports['.']).toEqual({
      import: { types: './dist/index.d.ts', default: './dist/index.js' },
      require: { types: './dist/index.d.cts', default: './dist/index.cjs' },
    });
  });
});
