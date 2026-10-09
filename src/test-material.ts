import { createHash } from 'node:crypto';

/**
 * SHA-256 (hex) of every app secret published in the shared test vectors
 * (`test/vectors/request-token.json`, `config.appSecret`). That secret is public by design, so a
 * real deployment signing or verifying delegations with it would accept forgeries from anyone who
 * has read the vectors. The client refuses it at construction.
 *
 * Only hashes live here, so the secret itself is not repeated in the shipped bundle.
 * `src/test-material.test.ts` reads the vectors file and fails when this list and the file
 * disagree, so a new or changed vector secret cannot slip past unnoticed.
 */
export const TEST_VECTOR_APP_SECRET_SHA256S: readonly string[] = [
  '02fb40655699045e01987ca0092bf6c18f562e24850a530348e50f4fb040dc7d',
];

export function isTestVectorAppSecret(value: string): boolean {
  const digest = createHash('sha256').update(value).digest('hex');
  return TEST_VECTOR_APP_SECRET_SHA256S.includes(digest);
}
