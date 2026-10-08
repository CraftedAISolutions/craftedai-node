import { z } from 'zod';

/**
 * FROZEN CONTRACT — signed MCP requests (spec 2026-10-02 §5.1, §5.2; CRA-350).
 *
 * The single source of truth for the request token core-api attaches to every
 * HTTP request it sends to a `jwt`-mode integration, and for the verifier
 * rules a customer MCP server applies (`@craftedai/node` `verifyRequest`, or
 * any other stack by hand). `@craftedai/node` copies these values verbatim;
 * nobody re-derives them from the spec or a ticket. Additive changes only
 * once this is on `main`: never rename, never narrow.
 *
 * Lives in `src/domain/` (not `src/api/`) because the application-layer
 * signer and the infrastructure fetch wrapper both need it, and neither may
 * import from `src/api`. `src/api/controllers/onboarding/onboarding-schemas.ts`
 * re-exports it so one import path covers the whole onboarding contract.
 */

// ---------------------------------------------------------------- wire constants

/** Request header carrying the compact JWS. Lower-case: HTTP header names are case-insensitive. */
export const REQUEST_TOKEN_HEADER = 'x-craftedai-request';
/** JOSE `typ` header value. Exact match, case-sensitive. */
export const REQUEST_TOKEN_TYP = 'craftedai-req+jwt';
/** The only accepted JOSE `alg`. Ed25519 per RFC 8037. `none`, HS*, RS*, ES* are all rejected. */
export const REQUEST_TOKEN_ALG = 'EdDSA';
/** `exp - iat`. Every token core-api mints lives exactly this long. */
export const REQUEST_TOKEN_LIFETIME_SECONDS = 60;
/** A verifier tolerates this much clock skew: `iat` may be at most this far in its future. */
export const REQUEST_TOKEN_MAX_CLOCK_SKEW_SECONDS = 60;

/** Public keys: `GET {iss}/.well-known/jwks.json`. */
export const JWKS_PATH = '/.well-known/jwks.json';
/** core-api serves the JWKS with `Cache-Control: public, max-age=300`. */
export const JWKS_CACHE_MAX_AGE_SECONDS = 300;
/** A verifier refetches the JWKS on an unknown `kid` at most this often. */
export const JWKS_UNKNOWN_KID_REFETCH_MIN_INTERVAL_SECONDS = 30;

/** `error` value of every verifier 401 body. */
export const VERIFICATION_FAILED_ERROR = 'craftedai_verification_failed';

/**
 * Every reason a verifier may return, in the order the checks run
 * (spec §5.2). Safe to return to the caller: each names a check, never a
 * secret. core-api records it as the `tools` setup step's failure detail.
 */
export const REQUEST_VERIFICATION_REASONS = [
  'missing_token',
  'bad_signature',
  'unknown_key',
  'wrong_issuer',
  'wrong_org',
  'wrong_audience',
  'expired',
  'replayed',
  'body_mismatch',
  'delegation_missing',
  'delegation_invalid',
  'delegation_user_mismatch',
  'delegation_exhausted',
] as const;
export type RequestVerificationReason = (typeof REQUEST_VERIFICATION_REASONS)[number];
export const RequestVerificationReasonSchema = z.enum(REQUEST_VERIFICATION_REASONS);

// ---------------------------------------------------------------- token shapes

/** base64url (no padding) of a 32-byte SHA-256 digest: always 43 characters. */
export const BODY_HASH_RE = /^[A-Za-z0-9_-]{43}$/;

/** Protected header. Unknown header members are ignored (stripped), never an error. */
export const RequestTokenHeaderSchema = z.object({
  alg: z.literal(REQUEST_TOKEN_ALG),
  typ: z.literal(REQUEST_TOKEN_TYP),
  kid: z.string().min(1).max(128),
});
export type RequestTokenHeader = z.infer<typeof RequestTokenHeaderSchema>;

/**
 * The end user a `tools/call` is made for. Present only on `tools/call`
 * requests that have an end user; absent on `initialize`, `tools/list`,
 * notifications, the GET stream and the DELETE.
 *
 * `externalUserId` is the customer's own user id for `channel: 'api'`
 * (embed and headless API), and the CraftedAI user id for `channel: 'web'`
 * (the hosted portal). A delegation token's `sub` must equal it (§5.2 rule 8).
 */
/** Channels core-api emits today; documentation and typing only, never a validation gate. */
export const KNOWN_CHANNELS = ['web', 'api'] as const;

export const RequestTokenActSchema = z.object({
  externalUserId: z.string().min(1).max(256),
  /** Open string (additive-only contract): unknown channels must not break deployed verifiers. */
  channel: z.string().min(1).max(32),
  conversationId: z.string().min(1).max(128),
});
export type RequestTokenAct = z.infer<typeof RequestTokenActSchema>;

/**
 * Claims. Ids are `min(1)` strings, not `.uuid()`: they are server-authoritative
 * and a verifier must compare them, never re-validate their shape (CRA-273).
 * Unknown claims are ignored (stripped), never an error, so core-api can add
 * claims without breaking deployed verifiers.
 */
export const RequestTokenClaimsSchema = z
  .object({
    /** Exactly the configured API origin, e.g. `https://api.craftedai.co`. No trailing slash. */
    iss: z.string().url(),
    /** The integration's endpoint URL exactly as stored in core-api. */
    aud: z.string().url(),
    /** The CraftedAI organization id (`CRAFTEDAI_ORG_ID`). */
    sub: z.string().min(1).max(128),
    /** The integration id. */
    iid: z.string().min(1).max(128),
    /** NumericDate, seconds. */
    iat: z.number().int().nonnegative(),
    /** NumericDate, seconds. Always `iat + REQUEST_TOKEN_LIFETIME_SECONDS` from core-api. */
    exp: z.number().int().positive(),
    /** UUID v4 from core-api; a verifier treats it as an opaque replay key. */
    jti: z.string().min(1).max(128),
    /** base64url(SHA-256(raw request body bytes)). An empty or absent body hashes the empty string. */
    bh: z.string().regex(BODY_HASH_RE),
    act: RequestTokenActSchema.optional(),
  })
  .refine((claims) => claims.exp > claims.iat, { message: 'exp must be after iat', path: ['exp'] });
export type RequestTokenClaims = z.infer<typeof RequestTokenClaimsSchema>;

/** base64url(SHA-256('')) — the `bh` of a request with no body (GET stream, DELETE). */
export const EMPTY_BODY_HASH = '47DEQpj8HBSa-_TImW-5JCeuQeRkm5NMpJWZG3hSuFU';

// ---------------------------------------------------------------- verifier 401 body

/**
 * Body of every verifier rejection (HTTP 401, `Content-Type: application/json`).
 * `message` is an optional human hint (e.g. expected vs seen audience URL);
 * it never contains a token, a secret, or a body.
 */
export const VerificationFailureBodySchema = z.object({
  error: z.literal(VERIFICATION_FAILED_ERROR),
  reason: RequestVerificationReasonSchema,
  message: z.string().max(500).optional(),
});
export type VerificationFailureBody = z.infer<typeof VerificationFailureBodySchema>;

// ---------------------------------------------------------------- JWKS

/** One public signing key as served by `GET {iss}/.well-known/jwks.json`. Never carries `d`. */
export const RequestSigningPublicJwkSchema = z
  .object({
    kty: z.literal('OKP'),
    crv: z.literal('Ed25519'),
    x: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
    kid: z.string().min(1).max(128),
    alg: z.literal(REQUEST_TOKEN_ALG),
    use: z.literal('sig'),
  })
  .strict();
export type RequestSigningPublicJwk = z.infer<typeof RequestSigningPublicJwkSchema>;

/** The JWKS document: the current key plus, during a rotation, the next one. Never a retired key. */
export const JwksResponseSchema = z
  .object({ keys: z.array(RequestSigningPublicJwkSchema).max(2) })
  .strict();
export type JwksResponse = z.infer<typeof JwksResponseSchema>;
