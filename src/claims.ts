import {
  BODY_HASH_RE,
  DELEGATION_TOKEN_ALG,
  DELEGATION_TOKEN_AUDIENCE,
  DELEGATION_TOKEN_ISSUER,
  DELEGATION_TOKEN_TYP,
  EXTERNAL_USER_ID_RE,
  REQUEST_TOKEN_ALG,
  REQUEST_TOKEN_TYP,
} from './contract.js';

/**
 * Hand-written mirrors of the core-api zod schemas (CRA-350), so the shipped
 * library needs no zod. Each guard returns the narrowed value or `null`; unknown
 * members are ignored, exactly like zod's default `strip`. Agreement with the
 * real schemas is pinned by `test/contract/contract-drift.test.ts`.
 */

export interface RequestTokenAct {
  externalUserId: string;
  /** Open string (additive-only contract); see `KNOWN_CHANNELS` for the values emitted today. */
  channel: string;
  conversationId: string;
}

export interface RequestTokenClaims {
  iss: string;
  aud: string;
  sub: string;
  iid: string;
  iat: number;
  exp: number;
  jti: string;
  bh: string;
  act?: RequestTokenAct;
}

export interface RequestTokenHeader {
  alg: typeof REQUEST_TOKEN_ALG;
  typ: typeof REQUEST_TOKEN_TYP;
  kid: string;
}

export interface DelegationTokenClaims {
  iss: typeof DELEGATION_TOKEN_ISSUER;
  aud: typeof DELEGATION_TOKEN_AUDIENCE;
  sub: string;
  org: string;
  iat: number;
  exp: number;
  jti: string;
}

export interface PublicSigningJwk {
  kty: 'OKP';
  crv: 'Ed25519';
  x: string;
  kid: string;
  alg: typeof REQUEST_TOKEN_ALG;
  use: 'sig';
}

type Rec = Record<string, unknown>;

const isRecord = (value: unknown): value is Rec =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const boundedString = (value: unknown, min: number, max: number): value is string =>
  typeof value === 'string' && value.length >= min && value.length <= max;

/** Mirrors zod v4 `z.string().url()`: parseable by WHATWG `URL`. */
export function isUrl(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  try {
    new URL(value);
    return true;
  } catch {
    return false;
  }
}

const isNonNegativeInt = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const isPositiveInt = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0;

/** `RequestTokenHeaderSchema`. */
export function parseRequestTokenHeader(value: unknown): RequestTokenHeader | null {
  if (!isRecord(value)) return null;
  const { alg, typ, kid } = value;
  if (alg !== REQUEST_TOKEN_ALG || typ !== REQUEST_TOKEN_TYP || !boundedString(kid, 1, 128)) {
    return null;
  }
  return { alg, typ, kid };
}

/** `RequestTokenActSchema`. */
export function parseRequestTokenAct(value: unknown): RequestTokenAct | null {
  if (!isRecord(value)) return null;
  const { externalUserId, channel, conversationId } = value;
  if (
    !boundedString(externalUserId, 1, 256) ||
    !boundedString(channel, 1, 32) ||
    !boundedString(conversationId, 1, 128)
  ) {
    return null;
  }
  return { externalUserId, channel, conversationId };
}

/** `RequestTokenClaimsSchema` (including the `exp > iat` refine). */
export function parseRequestTokenClaims(value: unknown): RequestTokenClaims | null {
  if (!isRecord(value)) return null;
  const { iss, aud, sub, iid, iat, exp, jti, bh, act } = value;
  if (
    !isUrl(iss) ||
    !isUrl(aud) ||
    !boundedString(sub, 1, 128) ||
    !boundedString(iid, 1, 128) ||
    !isNonNegativeInt(iat) ||
    !isPositiveInt(exp) ||
    !boundedString(jti, 1, 128) ||
    typeof bh !== 'string' ||
    !BODY_HASH_RE.test(bh)
  ) {
    return null;
  }
  const claims: RequestTokenClaims = { iss, aud, sub, iid, iat, exp, jti, bh };
  if (act !== undefined) {
    const parsedAct = parseRequestTokenAct(act);
    if (parsedAct === null) return null;
    claims.act = parsedAct;
  }
  return exp > iat ? claims : null;
}

/** `DelegationTokenHeaderSchema`. */
export function isDelegationTokenHeader(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return (
    value.alg === DELEGATION_TOKEN_ALG &&
    (value.typ === undefined || value.typ === DELEGATION_TOKEN_TYP)
  );
}

/** `DelegationTokenClaimsSchema` (including the `exp > iat` refine). */
export function parseDelegationTokenClaims(value: unknown): DelegationTokenClaims | null {
  if (!isRecord(value)) return null;
  const { iss, aud, sub, org, iat, exp, jti } = value;
  if (
    iss !== DELEGATION_TOKEN_ISSUER ||
    aud !== DELEGATION_TOKEN_AUDIENCE ||
    typeof sub !== 'string' ||
    !EXTERNAL_USER_ID_RE.test(sub) ||
    !boundedString(org, 1, 128) ||
    !isNonNegativeInt(iat) ||
    !isPositiveInt(exp) ||
    !boundedString(jti, 1, 128)
  ) {
    return null;
  }
  return exp > iat ? { iss, aud, sub, org, iat, exp, jti } : null;
}

/** `RequestSigningPublicJwkSchema` (strict: an extra member, e.g. a private `d`, is refused). */
export function parsePublicSigningJwk(value: unknown): PublicSigningJwk | null {
  if (!isRecord(value)) return null;
  const allowed = new Set(['kty', 'crv', 'x', 'kid', 'alg', 'use']);
  if (Object.keys(value).some((key) => !allowed.has(key))) return null;
  const { kty, crv, x, kid, alg, use } = value;
  if (
    kty !== 'OKP' ||
    crv !== 'Ed25519' ||
    typeof x !== 'string' ||
    !/^[A-Za-z0-9_-]{43}$/.test(x) ||
    !boundedString(kid, 1, 128) ||
    alg !== REQUEST_TOKEN_ALG ||
    use !== 'sig'
  ) {
    return null;
  }
  return { kty, crv, x, kid, alg, use };
}
