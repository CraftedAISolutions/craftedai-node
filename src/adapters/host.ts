import { CraftedAIError } from '../errors.js';
import { handleSessionRoute, type CreateSessionInput, type EmbedSessionBoot } from '../session.js';
import type { SessionRouteInput, SessionRouteResult } from '../session.js';
import type { RawRequest, VerifyResult } from '../verify.js';

/**
 * What a framework adapter may ask of the client. The client builds it from bound
 * closures, so an adapter (and anything that inspects one) can never reach the
 * client's own members or the integrator's objects (replay store, fetch, clock, onError).
 */
export interface AdapterHost {
  verifyRaw(request: RawRequest, publicUrl?: string | readonly string[]): Promise<VerifyResult>;
  /** `CraftedAI.verifyMcpRequest`: a fetch `Request`, audience without the query string. */
  verifyMcpRequest(
    request: Request,
    options?: { publicUrl?: string | readonly string[]; maxBodyBytes?: number },
  ): Promise<VerifyResult>;
  createSession(input: CreateSessionInput): Promise<EmbedSessionBoot>;
  /** Hands an error to the integrator's `onError`; a throwing hook never changes the response. */
  reportError(error: unknown): void;
  /** The widget's session route, with the mint and `onError` wired in. */
  sessionRoute(
    input: SessionRouteInput,
    options: { agentIds: readonly string[] | undefined; ttlSeconds: number | undefined },
  ): Promise<SessionRouteResult>;
}

export function createAdapterHost(deps: {
  verifyRaw: AdapterHost['verifyRaw'];
  verifyMcpRequest: AdapterHost['verifyMcpRequest'];
  createSession: AdapterHost['createSession'];
  onError: (error: unknown) => void;
}): AdapterHost {
  const reportError = (error: unknown): void => {
    try {
      deps.onError(error);
    } catch {
      // A broken logger must not turn a clean 5xx into a crash.
    }
  };
  return {
    verifyRaw: deps.verifyRaw,
    verifyMcpRequest: deps.verifyMcpRequest,
    createSession: deps.createSession,
    reportError,
    sessionRoute: (input, options) =>
      handleSessionRoute(input, options, deps.createSession, reportError),
  };
}

/** Body of the 5xx every guard answers when verification itself failed (store down, bug). */
export const VERIFICATION_UNAVAILABLE_BODY = {
  error: 'craftedai_verification_unavailable',
} as const;
/** Body of the 5xx a session route answers when `getUser` or the adapter itself failed. */
export const SESSION_UNAVAILABLE_BODY = { error: 'session_unavailable' } as const;

/** Seconds a client should wait before retrying when the verifier's backing store is down. */
export const VERIFICATION_RETRY_AFTER_SECONDS = '5';

/**
 * Status for a verifier that threw. A misconfigured client (`config_missing`/`config_invalid`)
 * stays a 500: retrying cannot help. Anything else is the verifier's backing store (replay
 * store, Redis) failing, which is transient: 503, with `Retry-After`.
 */
export function verificationFailureStatus(error: unknown): 500 | 503 {
  const misconfigured =
    error instanceof CraftedAIError &&
    (error.code === 'config_missing' || error.code === 'config_invalid');
  return misconfigured ? 500 : 503;
}

export const FETCH_CONSUMED_BODY_HINT =
  'the request body was already read; pass the untouched Request (e.g. Hono c.req.raw before c.req.json())';
