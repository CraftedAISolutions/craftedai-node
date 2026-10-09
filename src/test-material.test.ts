import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { vectors } from '../test/helpers/vectors.js';
import { isTestVectorAppSecret, TEST_VECTOR_APP_SECRET_SHA256S } from './test-material.js';

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

/** Every string under `value` whose own key looks like a secret. */
function secretsIn(value: unknown, path = ''): string[] {
  if (typeof value !== 'object' || value === null) return [];
  return Object.entries(value).flatMap(([key, child]) =>
    typeof child === 'string' && /secret/i.test(key) ? [child] : secretsIn(child, `${path}/${key}`),
  );
}

describe('test-vector material refusal list', () => {
  it('is exactly the SHA-256 of every secret the shared vectors publish (drift guard)', () => {
    const published = secretsIn(vectors);
    expect(published).toContain(vectors.config.appSecret);
    expect([...TEST_VECTOR_APP_SECRET_SHA256S].sort()).toEqual(published.map(sha256).sort());
  });

  it('refuses the published secret and nothing else', () => {
    expect(isTestVectorAppSecret(vectors.config.appSecret)).toBe(true);
    expect(isTestVectorAppSecret(`${vectors.config.appSecret}x`)).toBe(false);
    expect(isTestVectorAppSecret('kT3hJ9mQ2vXw7LpRzN5cYb8dFa1GeUo4sIiWnVj6HxA')).toBe(false);
  });

  it('does not store the secret itself, only its hash', () => {
    expect(TEST_VECTOR_APP_SECRET_SHA256S.join()).not.toContain(vectors.config.appSecret);
  });
});
