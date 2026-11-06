import { randomUUID } from 'node:crypto';
import { SignJWT, decodeProtectedHeader, jwtVerify } from 'jose';
import {
  isDelegationTokenHeader,
  parseDelegationTokenClaims,
  type DelegationTokenClaims,
} from './claims.js';
import {
  DELEGATION_MAX_CLOCK_SKEW_SECONDS,
  DELEGATION_TOKEN_ALG,
  DELEGATION_TOKEN_AUDIENCE,
  DELEGATION_TOKEN_ISSUER,
  DELEGATION_TOKEN_LIFETIME_SECONDS,
  DELEGATION_TOKEN_TYP,
} from './contract.js';

/** The HS256 key is the UTF-8 bytes of `CRAFTEDAI_APP_SECRET` as written (core-api Ruling 4). */
function hmacKey(appSecret: string): Uint8Array {
  return new TextEncoder().encode(appSecret);
}

export interface MintDelegationInput {
  appSecret: string;
  orgId: string;
  externalUserId: string;
  /** Unix seconds. */
  nowSeconds: number;
  lifetimeSeconds?: number;
  jti?: string;
}

export interface MintedDelegation {
  token: string;
  /** ISO-8601 instant of `exp` — what `POST /portal/v1/embed-sessions` takes as `delegation.expiresAt`. */
  expiresAt: string;
}

/** Spec §5.3: HS256, `iss craftedai-node`, `aud craftedai-delegation`, `sub` user, `org`, 300 s. */
export async function mintDelegationToken(input: MintDelegationInput): Promise<MintedDelegation> {
  const exp = input.nowSeconds + (input.lifetimeSeconds ?? DELEGATION_TOKEN_LIFETIME_SECONDS);
  const token = await new SignJWT({ org: input.orgId })
    .setProtectedHeader({ alg: DELEGATION_TOKEN_ALG, typ: DELEGATION_TOKEN_TYP })
    .setIssuer(DELEGATION_TOKEN_ISSUER)
    .setAudience(DELEGATION_TOKEN_AUDIENCE)
    .setSubject(input.externalUserId)
    .setIssuedAt(input.nowSeconds)
    .setExpirationTime(exp)
    .setJti(input.jti ?? randomUUID())
    .sign(hmacKey(input.appSecret));
  return { token, expiresAt: new Date(exp * 1000).toISOString() };
}

/**
 * Verifies a delegation token per spec §5.3 and core-api Rulings 2–3. Returns
 * the claims, or `null` for anything wrong (forged, expired, `iat` > 60 s
 * ahead, another org, wrong iss/aud, not HS256, `typ` other than `JWT`) — all
 * `delegation_invalid`.
 *
 * `previousAppSecret` (`CRAFTEDAI_APP_SECRET_PREVIOUS`) is the rotation overlap:
 * a token signed with it is still accepted, so the web app and the MCP can be
 * redeployed one after the other. It only ever verifies; `mintDelegationToken`
 * signs with the current secret alone.
 */
export async function verifyDelegationToken(
  token: string,
  options: {
    appSecret: string;
    previousAppSecret?: string | undefined;
    orgId: string;
    nowSeconds: number;
  },
): Promise<DelegationTokenClaims | null> {
  const secrets =
    options.previousAppSecret === undefined
      ? [options.appSecret]
      : [options.appSecret, options.previousAppSecret];
  for (const secret of secrets) {
    const claims = await verifyWithSecret(token, secret, options);
    if (claims !== null) return claims;
  }
  return null;
}

async function verifyWithSecret(
  token: string,
  appSecret: string,
  options: { orgId: string; nowSeconds: number },
): Promise<DelegationTokenClaims | null> {
  try {
    if (!isDelegationTokenHeader(decodeProtectedHeader(token))) return null;
    const { payload } = await jwtVerify(token, hmacKey(appSecret), {
      algorithms: [DELEGATION_TOKEN_ALG],
      issuer: DELEGATION_TOKEN_ISSUER,
      audience: DELEGATION_TOKEN_AUDIENCE,
      currentDate: new Date(options.nowSeconds * 1000),
      clockTolerance: 0,
    });
    const claims = parseDelegationTokenClaims(payload);
    if (claims === null) return null;
    if (claims.iat > options.nowSeconds + DELEGATION_MAX_CLOCK_SKEW_SECONDS) return null;
    if (claims.org !== options.orgId) return null;
    return claims;
  } catch {
    return null;
  }
}
