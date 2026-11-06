import { randomUUID } from 'node:crypto';
import { SignJWT, exportJWK, generateKeyPair } from 'jose';
import { bodyHash } from '../../src/body-hash.js';
import type { RequestTokenAct } from '../../src/claims.js';

/**
 * A request-token signer with its own freshly generated Ed25519 key (NOT a published test-vector
 * key), so `CraftedAI` can be exercised end to end exactly as production builds it: the JWKS
 * cache refuses the vector kids, and these tests never need it to trust them.
 */
export async function createOwnSigner(issuer: string, orgId: string) {
  const { publicKey, privateKey } = await generateKeyPair('EdDSA', { extractable: true });
  const kid = `own-${randomUUID()}`;
  const jwks = {
    keys: [{ ...(await exportJWK(publicKey)), kid, alg: 'EdDSA', use: 'sig' }],
  };
  return {
    jwks,
    /** A fetch that serves the JWKS for any URL. */
    fetch: (() => Promise.resolve(new Response(JSON.stringify(jwks)))) as unknown as typeof fetch,
    sign(input: {
      aud: string;
      body: string | null;
      nowSeconds: number;
      act?: RequestTokenAct;
      jti?: string;
    }): Promise<string> {
      return new SignJWT({
        iid: 'integration-1',
        bh: bodyHash(input.body === null ? null : new TextEncoder().encode(input.body)),
        ...(input.act !== undefined ? { act: input.act } : {}),
      })
        .setProtectedHeader({ alg: 'EdDSA', typ: 'craftedai-req+jwt', kid })
        .setIssuer(issuer)
        .setAudience(input.aud)
        .setSubject(orgId)
        .setIssuedAt(input.nowSeconds)
        .setExpirationTime(input.nowSeconds + 60)
        .setJti(input.jti ?? randomUUID())
        .sign(privateKey);
    },
  };
}
