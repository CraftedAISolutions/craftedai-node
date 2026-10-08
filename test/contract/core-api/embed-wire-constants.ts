/**
 * Shared wire-format primitives for the embeddable chat (spec §2, §3, §5, §7).
 *
 * Declared once here (F5) so both the API contract layer
 * (`src/api/controllers/embed/embed-session-schemas.ts`, which builds zod
 * validation around these values) and the application layer (which cannot
 * import from `src/api`) work from the same values. Consumers of either
 * layer quote these constants; they never re-derive them.
 */

/** `cais_` + 43 base64url chars = 256 bits. `cai_` (the gateway key) can never match. */
export const EMBED_SESSION_TOKEN_PREFIX = 'cais_';
export const EMBED_SESSION_TOKEN_RE = /^cais_[A-Za-z0-9_-]{43}$/;

/** Set by the widget from the handshake `MessageEvent.origin` on every embed request. */
export const EMBED_ANCESTOR_ORIGIN_HEADER = 'x-craftedai-ancestor-origin';
/** Sent by core-api to the partner MCP server on `tools/call` only. */
export const ACTOR_DELEGATION_HEADER = 'x-craftedai-actor-delegation';

/**
 * Session/delegation lifetime rules (fix-round-1 I2). Moved here — not left in
 * `src/api/controllers/embed/embed-session-schemas.ts` — because a later
 * application-layer service (embed-session minting) needs them for real
 * lifecycle logic and `src/application` cannot import from `src/api`.
 */

/** The widget posts `session-required { reason: 'expiring' }` this many seconds before expiry. */
export const EMBED_REFRESH_BEFORE_SECONDS = 60;
export const EMBED_SESSION_TTL_SECONDS = { min: 60, default: 900, max: 1800 } as const;
/** `delegation.expiresAt` must be in (now + 60s, now + 900s]. */
export const EMBED_DELEGATION_LIFETIME_SECONDS = { minExclusive: 60, max: 900 } as const;
/** An embed session never outlives its delegation token by more than this. */
export const EMBED_SESSION_DELEGATION_GRACE_SECONDS = 600;

/** Header-safe opaque token: printable ASCII, no spaces, no CR/LF. */
export const DELEGATION_TOKEN_RE = /^[\x21-\x7E]{16,4096}$/;
/**
 * Scheme + lowercase host (+ optional port). No path, query, fragment, userinfo or
 * trailing slash. Each label follows RFC 1035 (alnum start/end, hyphens only in the
 * middle) — not just the first label — and the port, if present, is bounded 0–65535
 * (PR #139 Copilot review: the previous pattern let `foo-.example.com` and
 * `:99999` through).
 */
const HOST_LABEL = '[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?';
const HOST_PORT =
  '(?:0|[1-9][0-9]{0,3}|[1-5][0-9]{4}|6[0-4][0-9]{3}|65[0-4][0-9]{2}|655[0-2][0-9]|6553[0-5])';
export const HOST_ORIGIN_RE = new RegExp(
  `^https://${HOST_LABEL}(?:\\.${HOST_LABEL})*(?::${HOST_PORT})?$`,
);

/**
 * Local test origins (spec 2026-10-02 §6.7, CRA-350): plain http on
 * `localhost` or `127.0.0.1`, optional port, nothing else. Accepted in
 * `allowedOrigins` and as a mint `hostOrigin`, and always reported with
 * `test: true`. `HOST_ORIGIN_RE` itself is never loosened (it is mirrored
 * byte for byte in chat-ui and core-ui).
 */
export const TEST_HOST_ORIGIN_RE = new RegExp(
  `^http://(?:localhost|127\\.0\\.0\\.1)(?::${HOST_PORT})?$`,
);

export function isTestHostOrigin(origin: string): boolean {
  return TEST_HOST_ORIGIN_RE.test(origin);
}

/** A production origin (`HOST_ORIGIN_RE`) or a local test origin (`TEST_HOST_ORIGIN_RE`). */
export function isAllowedHostOrigin(origin: string): boolean {
  return origin.length <= 253 && (HOST_ORIGIN_RE.test(origin) || TEST_HOST_ORIGIN_RE.test(origin));
}

/**
 * Every code an embed widget or partner backend must branch on. See the
 * status/route/action table on the response schemas in
 * `src/api/controllers/embed/embed-session-schemas.ts`.
 */
export const EMBED_ERROR_CODES = {
  invalidCredentials: 'invalid_credentials',
  agentUnavailable: 'agent_unavailable',
  embedOriginNotAllowed: 'embed_origin_not_allowed',
  delegationExpired: 'delegation_expired',
  delegationUnavailable: 'delegation_unavailable',
  writeToolLimitExceeded: 'embed_write_tool_limit_exceeded',
  writeToolLimitUnavailable: 'embed_write_tool_limit_unavailable',
  portalTurnLimitExceeded: 'portal_turn_limit_exceeded',
  portalTurnLimitUnavailable: 'portal_turn_limit_unavailable',
  rateLimitExceeded: 'rate_limit_exceeded',
  rateLimitUnavailable: 'service_unavailable',
  embedNotReady: 'embed_not_ready',
} as const;
export type EmbedErrorCode = (typeof EMBED_ERROR_CODES)[keyof typeof EMBED_ERROR_CODES];
