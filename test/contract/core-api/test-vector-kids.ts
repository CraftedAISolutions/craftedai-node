/**
 * Key ids of the published TEST-ONLY request-signing keys behind
 * `test/vectors/request-token.json` (CRA-350). Their private keys are derived
 * from public seeds, so they are compromised by design: every key-ring loader
 * (`EMBED_SIGNING_KEYS`) must refuse them. `vectors.test.ts` keeps this list
 * equal to the kids used in the vector file. Includes the key that is
 * deliberately absent from the vector JWKS (`unknown_key` case).
 */
export const TEST_VECTOR_KIDS: readonly string[] = [
  '_iUNiD3msWZh2EfcdIOLq-79H-Wt-zW3LObdQ94YKDA',
  'VxXG3LHaHjIYjqD4mDtShqDcOCQ1Ea2G3ldXvPbMHlA',
  'zcfL3RW9YWf_k--PzlvAYmAi7UzQg-lfjEpLKGg4WPM',
] as const;
