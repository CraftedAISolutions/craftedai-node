import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { REQUEST_VERIFICATION_REASONS } from '../src/contract.js';
import { verifyRawRequest } from '../src/verify.js';
import { VECTOR_FILE_PATH, vectorDeps, vectorRequest, vectors } from './helpers/vectors.js';

/**
 * The shared vectors (spec §9, §11): `test/vectors/request-token.json` is a
 * byte-for-byte copy of core-api's file, which its deterministic generator
 * pins. Every case must give core-api's reference verifier's verdict.
 */
const VECTOR_FILE_SHA256 = 'cfee0d9480264736fd7b6672febd704a6186b9ceed24db148ae024ad15ba532b';

describe('shared request-token vectors (CRA-350)', () => {
  it('is the frozen file, byte for byte', () => {
    const sha = createHash('sha256').update(readFileSync(VECTOR_FILE_PATH)).digest('hex');
    expect(sha).toBe(VECTOR_FILE_SHA256);
  });

  it('labels itself test-only and covers every reason code', () => {
    expect(vectors.WARNING).toMatch(/TEST-ONLY/);
    const reasons = new Set(
      vectors.cases.flatMap((c) => (c.expected.ok ? [] : [c.expected.reason])),
    );
    expect([...reasons].sort()).toEqual([...REQUEST_VERIFICATION_REASONS].sort());
  });

  it('has the 36 vectors', () => {
    expect(vectors.cases).toHaveLength(36);
  });

  it.each(vectors.cases.map((c) => [c.name, c] as const))('%s', async (_name, vector) => {
    const result = await verifyRawRequest(vectorRequest(vector), await vectorDeps(vector));
    const verdict = result.ok
      ? {
          ok: true,
          orgId: result.context.orgId,
          user: result.context.user,
          delegated: result.context.delegated,
        }
      : { ok: false, reason: result.reason };
    expect(verdict).toEqual(vector.expected);
  });
});
