import { readFileSync } from 'node:fs';
import { decodeJwt } from 'jose';
import { describe, expect, it } from 'vitest';
import { bodyHash } from './body-hash.js';
import { BODY_HASH_RE, EMPTY_BODY_HASH } from './contract.js';

const utf8 = (text: string) => new TextEncoder().encode(text);

describe('bodyHash', () => {
  it('hashes no body as the empty string', () => {
    expect(bodyHash(null)).toBe(EMPTY_BODY_HASH);
    expect(bodyHash(new Uint8Array())).toBe(EMPTY_BODY_HASH);
  });

  it('hashes the exact bytes (whitespace matters)', () => {
    const a = bodyHash(utf8('{"a":1}'));
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(bodyHash(utf8('{"a": 1}'))).not.toBe(a);
  });

  // Known answers computed independently with
  // createHash('sha256').update(...).digest('base64url').
  it('matches the SHA-256 known answer for a JSON body', () => {
    expect(bodyHash(utf8('{"a":1}'))).toBe('AVq9f1zFei3ZS3WQ8ErYCEJzkF7jPsXOvq5iJ2qX-GI');
  });

  it('hashes raw non-text bytes as bytes', () => {
    expect(bodyHash(Uint8Array.of(0xff, 0x00))).toBe('6l2_lZbRh-lQDyPppoAQlHU0HPToH34EP32XFSwQdy8');
  });
});

interface VectorCase {
  name: string;
  request: { headers: Record<string, string>; body: string | null };
}

const { cases } = JSON.parse(
  readFileSync(new URL('../test/vectors/request-token.json', import.meta.url), 'utf8'),
) as { cases: VectorCase[] };

function claimedBodyHash(token: string | undefined): string | null {
  if (token === undefined) return null;
  try {
    const { bh } = decodeJwt(token);
    return typeof bh === 'string' && BODY_HASH_RE.test(bh) ? bh : null;
  } catch {
    return null;
  }
}

describe('shared request-token vectors: body hash', () => {
  const withClaim = cases
    .filter((c) => !c.name.startsWith('body_mismatch'))
    .flatMap((c) => {
      const bh = claimedBodyHash(c.request.headers['x-craftedai-request']);
      return bh === null ? [] : [{ name: c.name, body: c.request.body, bh }];
    });

  it('covers the vectors', () => {
    expect(withClaim.length).toBeGreaterThanOrEqual(15);
    expect(withClaim.some((c) => c.body !== null && c.body.length > 0)).toBe(true);
  });

  it.each(withClaim.map((c) => [c.name, c] as const))(
    "reproduces the token's bh claim for %s",
    (_name, c) => {
      expect(bodyHash(c.body === null ? null : utf8(c.body))).toBe(c.bh);
    },
  );
});
