import { describe, expect, it } from 'vitest';
import { bodyHash } from './body-hash.js';
import { EMPTY_BODY_HASH } from './contract.js';

describe('bodyHash', () => {
  it('hashes no body as the empty string', () => {
    expect(bodyHash(null)).toBe(EMPTY_BODY_HASH);
    expect(bodyHash(new Uint8Array())).toBe(EMPTY_BODY_HASH);
  });

  it('hashes the exact bytes (whitespace matters)', () => {
    const a = bodyHash(new TextEncoder().encode('{"a":1}'));
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(bodyHash(new TextEncoder().encode('{"a": 1}'))).not.toBe(a);
  });
});
