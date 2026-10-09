import { assertSessionHandlerOptions, type SessionHandlerOptions } from '../session.js';
import { failureBody, type CraftedAIRequestContext } from '../verify.js';
import { SESSION_BODY_MAX_BYTES } from './audience.js';
import {
  SESSION_UNAVAILABLE_BODY,
  VERIFICATION_UNAVAILABLE_BODY,
  type AdapterHost,
} from './host.js';

/** A Web-standard handler: Next.js route handlers, Remix / React Router actions, Hono, Bun, Deno. */
export type FetchHandler = (request: Request) => Promise<Response>;

export interface FetchAdapter {
  /**
   * MCP guard. The handler gets an untouched copy of the request plus the verified context.
   * The audience is `request.url` without the query string or fragment; `X-Forwarded-*` and
   * `Forwarded` are never read. Behind a proxy (where `request.url` is the internal URL), set
   * `publicUrl`. A verification that itself fails (replay store down) answers 500
   * `craftedai_verification_unavailable`, calls `onError`, and never calls your handler.
   */
  verifyRequest(
    handler: (request: Request, context: CraftedAIRequestContext) => Response | Promise<Response>,
    options?: { publicUrl?: string | readonly string[] },
  ): FetchHandler;
  /** The widget's session route. `ttlSeconds` is validated here, when the handler is built. */
  sessionHandler(options: SessionHandlerOptions<Request>): FetchHandler;
}

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });

const TOO_LARGE = Symbol('too_large');

/** Reads a JSON body of at most 16 KiB; `TOO_LARGE` past the cap, undefined when absent or invalid. */
async function readSessionBody(request: Request): Promise<unknown> {
  const declared = Number(request.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > SESSION_BODY_MAX_BYTES) return TOO_LARGE;
  const stream = request.clone().body;
  if (stream === null) return undefined;
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > SESSION_BODY_MAX_BYTES) {
      // Not awaited: cancelling one branch of a clone settles only once the other is read too.
      void reader.cancel().catch(() => undefined);
      return TOO_LARGE;
    }
    chunks.push(value);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } catch {
    return undefined;
  }
}

export function createFetchAdapter(host: AdapterHost): FetchAdapter {
  return {
    verifyRequest(handler, options = {}) {
      return async (request) => {
        let verified;
        try {
          verified = await host.verifyMcpRequest(request, options);
        } catch (error) {
          // Fail closed: the error (which may carry a connection string) goes to onError, never
          // to the client, and the handler is not called.
          host.reportError(error);
          return json(500, VERIFICATION_UNAVAILABLE_BODY);
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
