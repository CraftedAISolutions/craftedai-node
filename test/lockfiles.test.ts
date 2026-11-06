import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * A release bumps `version` in package.json. The root lock and the lock of `examples/express`
 * (which depends on this package by `file:../..`) each record the package's version and its
 * dependency ranges; they go stale silently, because `npm ci` does not check a linked package.
 * This test fails the release gate when either one is behind.
 */
interface PackageJson {
  version: string;
  dependencies: Record<string, string>;
}
interface Lock {
  packages: Record<string, { version?: string; dependencies?: Record<string, string> }>;
}

const read = <T>(path: string): T =>
  JSON.parse(readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')) as T;
const pkg = read<PackageJson>('package.json');

describe('lockfiles follow package.json (release step: npm install --package-lock-only, root and examples/express)', () => {
  it.each([
    ['package-lock.json', ''],
    ['examples/express/package-lock.json', '../..'],
  ])('%s records this package at its current version and ranges', (file, key) => {
    const entry = read<Lock>(file).packages[key];
    expect(entry?.version).toBe(pkg.version);
    expect(entry?.dependencies).toEqual(pkg.dependencies);
  });
});
