import { z } from 'zod';

/**
 * FROZEN CONTRACT — the delegation token (spec 2026-10-02 §5.3; CRA-350).
 *
 * Minted by the customer's web app (`@craftedai/node` `sessionHandler`) with
 * `CRAFTEDAI_APP_SECRET`, carried opaquely by core-api in
 * `X-CraftedAI-Actor-Delegation`, verified by the customer's MCP
 * (`verifyRequest`). core-api never holds the secret and never parses the
 * token: it only checks the mint's `delegation.expiresAt` is 60–900 s away.
 * These values are frozen here so the library and the documented protocol
 * agree byte for byte. Additive changes only once on `main`.
 */

export const DELEGATION_TOKEN_ALG = 'HS256';
export const DELEGATION_TOKEN_TYP = 'JWT';
export const DELEGATION_TOKEN_ISSUER = 'craftedai-node';
export const DELEGATION_TOKEN_AUDIENCE = 'craftedai-delegation';
/** `exp - iat` for tokens `sessionHandler` mints. */
export const DELEGATION_TOKEN_LIFETIME_SECONDS = 300;
/** Default per-token ceiling on `tools/call` requests, counted per `jti` in the replay store. */
export const DELEGATION_DEFAULT_CALL_LIMIT = 20;
/** `CRAFTEDAI_APP_SECRET` is base64url of at least this many random bytes (init generates exactly 32). */
export const APP_SECRET_MIN_BYTES = 32;
/**
 * base64url, no padding, ≥ 32 bytes decoded (43 chars encodes 32 bytes).
 * The HS256 key is the UTF-8 bytes of this string exactly as written in
 * `.env` — NOT its base64url-decoded bytes — so every language gets the same
 * key without a decoding step.
 */
export const APP_SECRET_RE = /^[A-Za-z0-9_-]{43,}$/;
/**
 * Clock rule, same as the request token: `exp` strictly after the verifier's
 * now, `iat` at most `REQUEST_TOKEN_MAX_CLOCK_SKEW_SECONDS` (60) ahead of it.
 */
export const DELEGATION_MAX_CLOCK_SKEW_SECONDS = 60;

/** Same printable-ASCII rule as `X-External-User-Id` (embed-session-schemas). */
const EXTERNAL_USER_ID_RE = /^[\x21-\x7E]{1,256}$/;

export const DelegationTokenHeaderSchema = z.object({
  alg: z.literal(DELEGATION_TOKEN_ALG),
  typ: z.literal(DELEGATION_TOKEN_TYP).optional(),
});

export const DelegationTokenClaimsSchema = z
  .object({
    iss: z.literal(DELEGATION_TOKEN_ISSUER),
    aud: z.literal(DELEGATION_TOKEN_AUDIENCE),
    /** The customer's external user id — must equal the request token's `act.externalUserId`. */
    sub: z.string().regex(EXTERNAL_USER_ID_RE),
    /** The CraftedAI organization id — must equal `CRAFTEDAI_ORG_ID`. */
    org: z.string().min(1).max(128),
    iat: z.number().int().nonnegative(),
    exp: z.number().int().positive(),
    /** Replay-store key for the per-token call ceiling. */
    jti: z.string().min(1).max(128),
  })
  .refine((claims) => claims.exp > claims.iat, { message: 'exp must be after iat', path: ['exp'] });
export type DelegationTokenClaims = z.infer<typeof DelegationTokenClaimsSchema>;
