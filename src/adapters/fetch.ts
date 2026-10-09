import { CraftedAIError } from '../errors.js';
import { assertSessionHandlerOptions, type SessionHandlerOptions } from '../session.js';
import { failureBody, type CraftedAIRequestContext } from '../verify.js';
import { assertMaxBodyBytes, SESSION_BODY_MAX_BYTES } from './audience.js';
import { readCappedBody, TOO_LARGE } from './fetch-body.js';
import {
  SESSION_UNAVAILABLE_BODY,
  VERIFICATION_RETRY_AFTER_SECONDS,
  VERIFICATION_UNAVAILABLE_BODY,
  verificationFailureStatus,
  type AdapterHost,
} from './host.js';

/** A Web-standard handler: Next.js route handlers, Remix / React Router actions, Hono, Bun, Deno. */
export type FetchHandler = (request: Request) => Promise<Response>;

export interface FetchAdapter {
  /**
   * MCP guard. The handler gets an untouched copy of the request plus the verified context.
   * The body is read up to `maxBodyBytes` (default 1 MiB; a declared `Content-Length` over it
   * is refused first), then answered 413 `payload_too_large`. Pass the untouched `Request`: one
   * whose body was already read answers 401 `body_mismatch`.
   *
   * The audience is `request.url` without the query string or fragment; `X-Forwarded-*` and
   * `Forwarded` are never read. Behind a proxy (where `request.url` is the internal URL), set
   * `publicUrl`. Some fetch hosts build `request.url` themselves from forwarded headers; on
   * those hosts the client can influence it, and `publicUrl` is the only real pinning.
   *
   * A verification that itself fails (replay store down) answers 503
   * `craftedai_verification_unavailable` with `Retry-After: 5`, calls `onError`, and never calls
   * your handler. A misconfigured client (`config_missing`/`config_invalid`) answers 500.
   */
  verifyRequest(
    handler: (request: Request, context: CraftedAIRequestContext) => Response | Promise<Response>,
    options?: { publicUrl?: string | readonly string[]; maxBodyBytes?: number },
  ): FetchHandler;
  /** The widget's session route. `ttlSeconds` is validated here, when the handler is built. */
  sessionHandler(options: SessionHandlerOptions<Request>): FetchHandler;
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      ...headers,
    },
  });

/** Parses a JSON body of at most 16 KiB; `TOO_LARGE` past the cap, undefined when absent or invalid. */
async function readSessionBody(request: Request): Promise<unknown> {
  const bytes = await readCappedBody(request, SESSION_BODY_MAX_BYTES);
  if (bytes === TOO_LARGE) return TOO_LARGE;
  if (bytes === null) return undefined;
  try {
    return JSON.parse(Buffer.from(bytes).toString('utf8')) as unknown;
  } catch {
    return undefined;
  }
}

export function createFetchAdapter(host: AdapterHost): FetchAdapter {
  return {
    verifyRequest(handler, options = {}) {
      if (options.maxBodyBytes !== undefined) assertMaxBodyBytes(options.maxBodyBytes);
      return async (request) => {
        let verified;
        try {
          verified = await host.verifyMcpRequest(request, options);
        } catch (error) {
          // Fail closed: the error goes to onError, never to the client, and the handler is not
          // called. A CraftedAIError never carries a secret, but this may be your own replay
          // store's error, whose message the library does not control.
          if (error instanceof CraftedAIError && error.code === 'payload_too_large') {
            return json(413, { error: 'payload_too_large' });
          }
          host.reportError(error);
          const status = verificationFailureStatus(error);
          return json(
            status,
            VERIFICATION_UNAVAILABLE_BODY,
            status === 503 ? { 'retry-after': VERIFICATION_RETRY_AFTER_SECONDS } : {},
          );
        }
        if (!verified.ok) return json(401, failureBody(verified));
        return handler(request, verified.context);
      };
    },

    sessionHandler(options) {
      assertSessionHandlerOptions(options);
      const routeOptions = { agentIds: options.agentIds, ttlSeconds: options.ttlSeconds };
      return async (request) => {
        try {
          const body = await readSessionBody(request);
          if (body === TOO_LARGE) return json(413, { error: 'payload_too_large' });
          const result = await host.sessionRoute(
            {
              user: await options.getUser(request),
              contentType: request.headers.get('content-type') ?? undefined,
              origin: request.headers.get('origin') ?? undefined,
              body,
            },
            routeOptions,
          );
          return json(result.status, result.body);
        } catch (error) {
          host.reportError(error);
          return json(500, SESSION_UNAVAILABLE_BODY);
        }
      };
    },
  };
}
