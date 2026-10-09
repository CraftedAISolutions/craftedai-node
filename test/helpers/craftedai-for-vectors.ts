import { CraftedAI } from '../../src/craftedai.js';
import type { CraftedAIOptions } from '../../src/config.js';
import type { RequestTokenAct } from '../../src/claims.js';
import { APP_SECRET } from './core-api-stub.js';
import { createOwnSigner } from './own-signer.js';
import { mintDelegationToken } from '../../src/delegation.js';
import { NOW, VECTOR_CONFIG } from './sign.js';
import { vectors } from './vectors.js';

/**
 * The shared vectors' issuer, org and clock, with a freshly generated signing key.
 *
 * `CraftedAI` refuses the published vector keys and the published vector app secret (they are
 * derived from public seeds), so a test going through the client cannot use `sign.ts`'s vector
 * private key. The signer here has its own key; the client trusts it through a JWKS fetch stub.
 */
const signer = await createOwnSigner(vectors.config.issuer, vectors.config.orgId);

/** A client for the vectors' issuer and org, trusting `signRequest`'s key, clock frozen at NOW. */
export function craftedaiForVectors(options: CraftedAIOptions = {}): CraftedAI {
  return new CraftedAI({
    apiOrigin: vectors.config.issuer,
    orgId: vectors.config.orgId,
    appSecret: APP_SECRET,
    env: {},
    now: () => NOW * 1000,
    fetch: signer.fetch,
    ...options,
  });
}

/** A request token the clients above accept; the audience defaults to the vectors' public URL. */
export function signRequest(input: {
  body: string | null;
  act?: RequestTokenAct;
  aud?: string;
  jti?: string;
}): Promise<string> {
  return signer.sign({
    aud: input.aud ?? VECTOR_CONFIG.publicUrl,
    body: input.body,
    nowSeconds: NOW,
    ...(input.act !== undefined ? { act: input.act } : {}),
    ...(input.jti !== undefined ? { jti: input.jti } : {}),
  });
}

/** A delegation token signed with the same app secret the helper's clients hold. */
export async function delegationFor(externalUserId: string): Promise<string> {
  const { token } = await mintDelegationToken({
    appSecret: APP_SECRET,
    orgId: vectors.config.orgId,
    externalUserId,
    nowSeconds: NOW,
  });
  return token;
}
