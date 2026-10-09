/**
 * FROZEN CONTRACT — copied verbatim from core-api (CRA-350, merged at d51e02a):
 *   src/domain/request-signing/request-token-wire.ts
 *   src/domain/request-signing/delegation-token-wire.ts
 *   src/domain/embed/embed-wire-constants.ts
 *   src/domain/request-signing/test-vector-kids.ts
 *
 * Values only: the library ships with one runtime dependency (`jose`), so the
 * zod schemas are mirrored by hand in `claims.ts`. Both the values here and the
 * hand mirrors are checked against verbatim copies of the core-api files in
 * `test/contract/contract-drift.test.ts`. Never edit a value here without the
 * matching core-api change on `main` first.
 */

// ---------------------------------------------------------------- request token (spec §5.1, §5.2)

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

/**
 * Key ids of the published TEST-ONLY signing keys behind `test/vectors/request-token.json`
 * (core-api `test-vector-kids.ts`). Their private keys derive from public seeds, so a
 * verifier must never trust them in production: `JwksCache` drops them unless told otherwise.
 */
export const TEST_VECTOR_KIDS: readonly string[] = [
  '_iUNiD3msWZh2EfcdIOLq-79H-Wt-zW3LObdQ94YKDA',
  'VxXG3LHaHjIYjqD4mDtShqDcOCQ1Ea2G3ldXvPbMHlA',
  'zcfL3RW9YWf_k--PzlvAYmAi7UzQg-lfjEpLKGg4WPM',
] as const;

/** `error` value of every verifier 401 body. */
export const VERIFICATION_FAILED_ERROR = 'craftedai_verification_failed';

/** Every reason a verifier may return, in the order the checks run (spec §5.2). */
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

/** Channels core-api emits today; documentation and typing only, never a validation gate. */
export const KNOWN_CHANNELS = ['web', 'api'] as const;

/** base64url (no padding) of a 32-byte SHA-256 digest: always 43 characters. */
export const BODY_HASH_RE = /^[A-Za-z0-9_-]{43}$/;

/** base64url(SHA-256('')) — the `bh` of a request with no body (GET stream, DELETE). */
export const EMPTY_BODY_HASH = '47DEQpj8HBSa-_TImW-5JCeuQeRkm5NMpJWZG3hSuFU';

/** Sent by core-api to the partner MCP server on `tools/call` only (core-api embed-wire-constants). */
export const ACTOR_DELEGATION_HEADER = 'x-craftedai-actor-delegation';

// ---------------------------------------------------------------- delegation token (spec §5.3)

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
 * base64url, no padding, ≥ 32 bytes decoded. The HS256 key is the UTF-8 bytes
 * of this string exactly as written in `.env` — NOT its decoded bytes.
 */
export const APP_SECRET_RE = /^[A-Za-z0-9_-]{43,}$/;
/** Clock rule, same as the request token: `exp` strictly after now, `iat` ≤ now + 60 s. */
export const DELEGATION_MAX_CLOCK_SKEW_SECONDS = 60;

/** Same printable-ASCII rule as `X-External-User-Id` (core-api embed-session-schemas). */
export const EXTERNAL_USER_ID_RE = /^[\x21-\x7E]{1,256}$/;

// ---------------------------------------------------------------- embed sessions (core-api embed-wire-constants)

/** `POST`/`DELETE {apiOrigin}/portal/v1/embed-sessions`. */
export const EMBED_SESSIONS_PATH = '/portal/v1/embed-sessions';
/** `GET {apiOrigin}/portal/v1/key-info` (CLI init). */
export const KEY_INFO_PATH = '/portal/v1/key-info';
/** Embed session lifetime bounds; `default` is what `createSession` sends. */
export const EMBED_SESSION_TTL_SECONDS = { min: 60, default: 900, max: 1800 } as const;
/** `cais_` + 43 base64url chars. */
export const EMBED_SESSION_TOKEN_RE = /^cais_[A-Za-z0-9_-]{43}$/;

// ---------------------------------------------------------------- defaults

export const DEFAULT_API_ORIGIN = 'https://api.craftedai.co';
export const DEFAULT_CHAT_ORIGIN = 'https://chat.craftedai.co';
