import { assertAppSecret, ENV } from './config.js';
import {
  DELEGATION_TOKEN_LIFETIME_SECONDS,
  EMBED_SESSION_TOKEN_RE,
  EMBED_SESSION_TTL_SECONDS,
  EMBED_SESSIONS_PATH,
  EXTERNAL_USER_ID_RE,
} from './contract.js';
import { mintDelegationToken } from './delegation.js';
import { CraftedAIError } from './errors.js';

/**
 * What the session route returns to the widget (core-api
 * `EmbedHostBootPayloadSchema`; chat-ui `session-bridge.ts` reads `token`,
 * `expiresAt`, `refreshBeforeSeconds`, `frameOrigin`, `branding`). Never the
 * `cai_` key, never the delegation token.
 */
export interface EmbedSessionBoot {
  token: string;
  expiresAt: string;
  refreshBeforeSeconds: number;
  frameUrl: string;
  frameOrigin: string;
  branding: Record<string, unknown>;
}

export interface CreateSessionInput {
  /** Your own id for the signed-in user: 1–256 printable ASCII, no spaces. */
  externalUserId: string;
  /** The agent id from the widget (`data-agent`). core-api checks the key may mint for it. */
  agentId: string;
  /** Exact origin of the page framing the widget (the request's `Origin`). */
  hostOrigin: string;
  /** Embed session lifetime, 60–1800 s. Default 900. */
  ttlSeconds?: number;
}

export interface SessionDeps {
  apiOrigin: string;
  secretKey: string;
  appSecret: string;
  orgId: string;
  fetch: typeof fetch;
  now: () => number;
}

const REQUEST_TIMEOUT_MS = 10_000;

function assertTtlSeconds(ttlSeconds: number): void {
  const { min, max } = EMBED_SESSION_TTL_SECONDS;
  if (!Number.isInteger(ttlSeconds) || ttlSeconds < min || ttlSeconds > max) {
    throw new CraftedAIError(
      'invalid_argument',
      `ttlSeconds must be a whole number between ${min} and ${max}`,
    );
  }
}

function assertExternalUserId(externalUserId: string): void {
  if (!EXTERNAL_USER_ID_RE.test(externalUserId)) {
    throw new CraftedAIError(
      'invalid_argument',
      'user id must be 1–256 printable ASCII characters with no spaces',
    );
  }
}

async function errorCode(response: Response): Promise<string | undefined> {
  try {
    const body: unknown = await response.json();
    const code =
      typeof body === 'object' && body !== null ? (body as { error?: unknown }).error : undefined;
    return typeof code === 'string' ? code : undefined;
  } catch {
    return undefined;
  }
}

async function toMintError(response: Response): Promise<CraftedAIError> {
  const code = await errorCode(response);
  const status = response.status;
  if (status === 401) {
    return new CraftedAIError('invalid_credentials', 'CraftedAI refused the server key', status);
  }
  if (status === 403 && code === 'agent_not_allowed_for_key') {
    return new CraftedAIError(
      'agent_not_allowed_for_key',
      'this server key may not mint for this agent',
      status,
    );
  }
  if (status === 403 && code === 'embed_origin_not_allowed') {
    return new CraftedAIError(
      'embed_origin_not_allowed',
      "the page origin is not on the agent's website list",
      status,
    );
  }
  if (status === 404) {
    return new CraftedAIError(
      'agent_unavailable',
      'the agent is not published or not embed-enabled',
      status,
    );
  }
  if (status === 400) {
    return new CraftedAIError('invalid_request', 'CraftedAI refused the session request', status);
  }
  return new CraftedAIError('api_unavailable', `CraftedAI answered ${status}`, status);
}

function readBoot(body: unknown): EmbedSessionBoot | null {
  if (typeof body !== 'object' || body === null) return null;
  const { embedSession, branding } = body as { embedSession?: unknown; branding?: unknown };
  if (typeof embedSession !== 'object' || embedSession === null) return null;
  if (typeof branding !== 'object' || branding === null) return null;
  const s = embedSession as Record<string, unknown>;
  if (
    typeof s.token !== 'string' ||
    !EMBED_SESSION_TOKEN_RE.test(s.token) ||
    typeof s.expiresAt !== 'string' ||
    typeof s.refreshBeforeSeconds !== 'number' ||
    typeof s.frameUrl !== 'string' ||
    typeof s.frameOrigin !== 'string'
  ) {
    return null;
  }
  return {
    token: s.token,
    expiresAt: s.expiresAt,
    refreshBeforeSeconds: s.refreshBeforeSeconds,
    frameUrl: s.frameUrl,
    frameOrigin: s.frameOrigin,
    branding: branding as Record<string, unknown>,
  };
}

/**
 * Spec §5.3 + §5.5: mint a 300 s delegation token for the user, then
 * `POST {apiOrigin}/portal/v1/embed-sessions` with the server key.
 */
export async function createSession(
  input: CreateSessionInput,
  deps: SessionDeps,
): Promise<EmbedSessionBoot> {
  // The mint layer validates nothing by design, so everything is checked here, before any
  // token is signed or any request leaves the process.
  assertExternalUserId(input.externalUserId);
  const ttlSeconds = input.ttlSeconds ?? EMBED_SESSION_TTL_SECONDS.default;
  assertTtlSeconds(ttlSeconds);
  assertAppSecret(ENV.appSecret, deps.appSecret);
  const delegation = await mintDelegationToken({
    appSecret: deps.appSecret,
    orgId: deps.orgId,
    externalUserId: input.externalUserId,
    nowSeconds: Math.floor(deps.now() / 1000),
    // Fixed by the contract (spec §5.3); never derived from the embed session ttl.
    lifetimeSeconds: DELEGATION_TOKEN_LIFETIME_SECONDS,
  });
  let response: Response;
  try {
    response = await deps.fetch(`${deps.apiOrigin}${EMBED_SESSIONS_PATH}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${deps.secretKey}`,
        'x-external-user-id': input.externalUserId,
        'content-type': 'application/json',
        accept: 'application/json',
      },
      body: JSON.stringify({
        agentId: input.agentId,
        hostOrigin: input.hostOrigin,
        delegation: { token: delegation.token, expiresAt: delegation.expiresAt },
        ttlSeconds,
      }),
      redirect: 'error',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    throw new CraftedAIError('api_unavailable', `could not reach ${deps.apiOrigin}`);
  }
  if (response.status !== 201) throw await toMintError(response);
  const boot = readBoot(await response.json().catch(() => null));
  if (boot === null) throw new CraftedAIError('api_unavailable', 'unexpected session response');
  return boot;
}

/**
 * Spec §4.2: on logout, `DELETE {apiOrigin}/portal/v1/embed-sessions` for the
 * user — the widget's session dies on its next request, and core-api stops
 * forwarding the user's delegation token.
 */
export async function revokeSessions(
  externalUserId: string,
  deps: Pick<SessionDeps, 'apiOrigin' | 'secretKey' | 'fetch'>,
): Promise<void> {
  assertExternalUserId(externalUserId);
  let response: Response;
  try {
    response = await deps.fetch(`${deps.apiOrigin}${EMBED_SESSIONS_PATH}`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${deps.secretKey}`, 'x-external-user-id': externalUserId },
      redirect: 'error',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    throw new CraftedAIError('api_unavailable', `could not reach ${deps.apiOrigin}`);
  }
  if (response.status === 401) {
    throw new CraftedAIError('invalid_credentials', 'CraftedAI refused the server key', 401);
  }
  if (response.status !== 204) {
    throw new CraftedAIError(
      'api_unavailable',
      `CraftedAI answered ${response.status}`,
      response.status,
    );
  }
}

// ---------------------------------------------------------------- framework-neutral session route

export interface SessionHandlerOptions<Req> {
  /** Your signed-in user's id for this request, or null/undefined when signed out (→ 401). */
  getUser: (request: Req) => string | null | undefined | Promise<string | null | undefined>;
  /** Restrict which agents this route mints for. Default: whatever the server key allows. */
  agentIds?: readonly string[];
  ttlSeconds?: number;
}

export interface SessionRouteInput {
  user: string | null | undefined;
  contentType: string | undefined;
  origin: string | undefined;
  body: unknown;
}

export interface SessionRouteResult {
  status: number;
  body: unknown;
}

const AGENT_ID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A browser `Origin` that survives a round trip through `URL`: rejects `null`, '', paths, junk. */
function isBareOrigin(origin: string | undefined): origin is string {
  if (origin === undefined) return false;
  try {
    return new URL(origin).origin === origin;
  } catch {
    return false;
  }
}

/**
 * The widget's `POST data-session-endpoint` (chat-ui session-bridge): body
 * `{ agentId }`, same-origin, JSON. 401/403/404 make the widget show
 * "signed out"; anything else is an error it logs with a fixed line.
 */
export async function handleSessionRoute(
  input: SessionRouteInput,
  options: { agentIds: readonly string[] | undefined; ttlSeconds: number | undefined },
  mint: (input: CreateSessionInput) => Promise<EmbedSessionBoot>,
  onError: (error: unknown) => void,
): Promise<SessionRouteResult> {
  // JSON only: a cross-site form post cannot send it without a CORS preflight.
  if (input.contentType?.split(';')[0]?.trim().toLowerCase() !== 'application/json') {
    return { status: 415, body: { error: 'unsupported_media_type' } };
  }
  if (input.user === null || input.user === undefined || input.user === '') {
    return { status: 401, body: { error: 'unauthenticated' } };
  }
  const agentId =
    typeof input.body === 'object' && input.body !== null
      ? (input.body as { agentId?: unknown }).agentId
      : undefined;
  // Local validation, before any mint: client garbage is the client's 400, never a 502 that
  // reaches onError. Shape only (8-4-4-4-12 hex): core-api stays the authority on the agent.
  if (typeof agentId !== 'string' || !AGENT_ID_SHAPE.test(agentId)) {
    return { status: 400, body: { error: 'invalid_request' } };
  }
  if (options.agentIds !== undefined && !options.agentIds.includes(agentId)) {
    return { status: 403, body: { error: 'agent_not_allowed' } };
  }
  if (!isBareOrigin(input.origin)) {
    return { status: 400, body: { error: 'origin_required' } };
  }
  try {
    const boot = await mint({
      externalUserId: input.user,
      agentId,
      hostOrigin: input.origin,
      ...(options.ttlSeconds !== undefined ? { ttlSeconds: options.ttlSeconds } : {}),
    });
    return { status: 200, body: boot };
  } catch (error) {
    // Expected integration outcomes (unknown/unpublished agent, origin or key not allowed, bad
    // input) are answered without onError; only an unexpected failure (the 502) is reported.
    const code = error instanceof CraftedAIError ? error.code : undefined;
    if (code === 'agent_unavailable') return { status: 404, body: { error: code } };
    if (code === 'agent_not_allowed_for_key' || code === 'embed_origin_not_allowed') {
      return { status: 403, body: { error: code } };
    }
    if (code === 'invalid_argument') return { status: 400, body: { error: 'invalid_request' } };
    onError(error);
    return { status: 502, body: { error: 'session_unavailable' } };
  }
}
