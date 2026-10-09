import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { vectors } from '../test/helpers/vectors.js';
import { APP_SECRET_RE } from './contract.js';
import { isTestVectorAppSecret, TEST_VECTOR_APP_SECRET_SHA256S } from './test-material.js';

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

/** Every string anywhere in `value` that is shaped like an app secret. */
function secretShapedStrings(value: unknown): string[] {
  if (typeof value === 'string') return APP_SECRET_RE.test(value) ? [value] : [];
  if (typeof value !== 'object' || value === null) return [];
  return Object.values(value).flatMap(secretShapedStrings);
}

describe('test-vector material refusal list', () => {
  const published = [...new Set(secretShapedStrings(vectors))];

  it('is exactly the SHA-256 of every secret-shaped string the shared vectors publish (drift guard)', () => {
    expect(published).toContain(vectors.config.appSecret);
    expect([...TEST_VECTOR_APP_SECRET_SHA256S].sort()).toEqual(published.map(sha256).sort());
  });

  it('covers the published private key members, public keys and kids too', () => {
    const keys = Object.values(vectors.testOnlyPrivateKeys);
    expect(keys.length).toBeGreaterThan(0);
    for (const jwk of keys) {
      for (const member of ['d', 'x', 'kid'] as const) {
        expect(isTestVectorAppSecret(jwk[member]!)).toBe(true);
      }
    }
  });

  it('refuses the published secret and nothing else', () => {
    expect(isTestVectorAppSecret(vectors.config.appSecret)).toBe(true);
    expect(isTestVectorAppSecret(`${vectors.config.appSecret}x`)).toBe(false);
    expect(isTestVectorAppSecret('kT3hJ9mQ2vXw7LpRzN5cYb8dFa1GeUo4sIiWnVj6HxA')).toBe(false);
  });

  it('stores no plaintext, only hashes', () => {
    for (const value of published) {
      expect(TEST_VECTOR_APP_SECRET_SHA256S.join()).not.toContain(value);
    }
  });
});
