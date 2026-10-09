import { randomUUID } from 'node:crypto';
import { SignJWT, importJWK } from 'jose';
import { bodyHash } from '../../src/body-hash.js';
import type { RequestTokenAct } from '../../src/claims.js';
import { mintDelegationToken } from '../../src/delegation.js';
import { vectors } from './vectors.js';

/** TEST-ONLY: signs with the vector `current` (or `next`) private key from the shared vectors. */
export const NOW = 1_790_000_000;
export const { config: VECTOR_CONFIG } = vectors;

export async function signRequest(input: {
  body: string | null;
  act?: RequestTokenAct;
  key?: 'current' | 'next' | 'notInJwks';
  iat?: number;
  aud?: string;
  jti?: string;
}): Promise<string> {
  const jwk = vectors.testOnlyPrivateKeys[input.key ?? 'current'];
  const iat = input.iat ?? NOW;
  return new SignJWT({
    iid: VECTOR_CONFIG.integrationId,
    bh: bodyHash(input.body === null ? null : new TextEncoder().encode(input.body)),
    ...(input.act !== undefined ? { act: input.act } : {}),
  })
    .setProtectedHeader({ alg: 'EdDSA', typ: 'craftedai-req+jwt', kid: jwk.kid! })
    .setIssuer(VECTOR_CONFIG.issuer)
    .setAudience(input.aud ?? VECTOR_CONFIG.publicUrl)
    .setSubject(VECTOR_CONFIG.orgId)
    .setIssuedAt(iat)
    .setExpirationTime(iat + 60)
    .setJti(input.jti ?? randomUUID())
    .sign(await importJWK(jwk, 'EdDSA'));
}

export async function delegationFor(
  externalUserId: string,
  jti: string = randomUUID(),
): Promise<string> {
  const { token } = await mintDelegationToken({
    appSecret: VECTOR_CONFIG.appSecret,
    orgId: VECTOR_CONFIG.orgId,
    externalUserId,
    nowSeconds: NOW,
    jti,
  });
  return token;
}
