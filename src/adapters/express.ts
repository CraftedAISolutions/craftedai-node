import type { IncomingMessage, ServerResponse } from 'node:http';
import type { TLSSocket } from 'node:tls';
import { assertSessionHandlerOptions, type SessionHandlerOptions } from '../session.js';
import { failureBody, type CraftedAIRequestContext } from '../verify.js';
import {
  assertMaxBodyBytes,
  audienceUrl,
  MAX_BODY_BYTES,
  SESSION_BODY_MAX_BYTES,
} from './audience.js';
import {
  SESSION_UNAVAILABLE_BODY,
  VERIFICATION_UNAVAILABLE_BODY,
  type AdapterHost,
} from './host.js';
import {
  BodyTooLargeError,
  CONSUMED_BODY_HINT,
  headerOf,
  parseJsonBody,
  readRawBody,
  sendJson,
} from './node-body.js';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace -- Express's own augmentation point
  namespace Express {
    interface Request {
      /** Set by `craftedai.express.verifyRequest()` on a verified request. */
      craftedai?: CraftedAIRequestContext;
      rawBody?: Buffer | Uint8Array;
    }
  }
}

/** The parts of an Express request the adapter reads; any Node `IncomingMessage` works. */
export interface ExpressLikeRequest extends IncomingMessage {
  body?: unknown;
  rawBody?: unknown;
  /** Express: `http`/`https`; honours the app's own `trust proxy` setting. */
  protocol?: string;
  originalUrl?: string;
  craftedai?: CraftedAIRequestContext;
}
export type ExpressLikeHandler = (
  req: ExpressLikeRequest,
  res: ServerResponse,
  next: (error?: unknown) => void,
) => void;

export interface ExpressVerifyOptions {
  /** The MCP URL(s) exactly as registered in CraftedAI. Set it behind a proxy (spec §12.1). */
  publicUrl?: string | readonly string[];
  /** Largest request body the guard buffers; larger is answered 413. Default 1 MiB. */
  maxBodyBytes?: number;
}

export interface ExpressAdapter {
  /**
   * MCP guard (spec §5.2). Mount it BEFORE any body parser:
   *   app.post('/mcp', craftedai.express.verifyRequest(), mcpHandler)
   *
   * The guard reads the raw body itself (at most `maxBodyBytes`, then 413). On success
   * `req.craftedai` is set, `req.rawBody` holds the exact bytes and `req.body` the parsed JSON
   * (a later `express.json()` is a no-op). If a body parser already consumed the stream it
   * answers 401 `body_mismatch` naming that cause (spec §12.3). A verification that itself
   * fails (replay store down) answers 500 `craftedai_verification_unavailable`, calls
   * `onError`, and never reaches your handler.
   *
   * The audience is `req.protocol://Host/originalUrl-path` without the query string.
   * `X-Forwarded-Host` and `Forwarded` are never read; `X-Forwarded-Proto` counts only through
   * Express's own `req.protocol` if you enabled `trust proxy`. Behind a proxy, set `publicUrl`.
   */
  verifyRequest(options?: ExpressVerifyOptions): ExpressLikeHandler;
  /**
   * The widget's session route:
   * `app.post('/craftedai/session', craftedai.express.sessionHandler({ getUser }))`.
   * `ttlSeconds` is validated here, when the handler is built.
   */
  sessionHandler(options: SessionHandlerOptions<ExpressLikeRequest>): ExpressLikeHandler;
}

/** The URL this request reached, as Express sees it, without the query string. */
function requestUrl(req: ExpressLikeRequest): string {
  const protocol =
    req.protocol ?? ((req.socket as Partial<TLSSocket>).encrypted === true ? 'https' : 'http');
  const host = headerOf(req, 'host') ?? 'localhost';
  return audienceUrl(protocol, host, req.originalUrl ?? req.url ?? '/');
}

export function createExpressAdapter(host: AdapterHost): ExpressAdapter {
  return {
    verifyRequest(options = {}) {
      const maxBodyBytes = options.maxBodyBytes ?? MAX_BODY_BYTES;
      assertMaxBodyBytes(maxBodyBytes);
      return (req, res, next) => {
        void (async () => {
          let read;
          try {
            read = await readRawBody(req, maxBodyBytes);
          } catch (error) {
            if (error instanceof BodyTooLargeError) {
              res.setHeader('connection', 'close');
              sendJson(res, 413, { error: 'payload_too_large' });
              return;
            }
            throw error;
          }
          if (read.status === 'consumed') {
            sendJson(
              res,
              401,
              failureBody({ ok: false, reason: 'body_mismatch', message: CONSUMED_BODY_HINT }),
            );
            return;
          }
          const result = await host.verifyRaw(
            {
              method: req.method ?? 'GET',
              url: requestUrl(req),
              header: (name) => headerOf(req, name),
              body: read.body,
            },
            options.publicUrl,
          );
          if (!result.ok) {
            sendJson(res, 401, failureBody(result));
            return;
          }
          req.craftedai = result.context;
          if (read.body !== null) {
            req.rawBody = read.body;
            req.body ??= parseJsonBody(read.body, headerOf(req, 'content-type'));
          }
          next();
        })().catch((error: unknown) => {
          // Fail closed: a verifier that could not decide never lets the request through, and
          // the error (which may carry a connection string) is for onError, never the client.
          host.reportError(error);
          if (!res.headersSent) sendJson(res, 500, VERIFICATION_UNAVAILABLE_BODY);
        });
      };
    },

    sessionHandler(options) {
      assertSessionHandlerOptions(options);
      const routeOptions = { agentIds: options.agentIds, ttlSeconds: options.ttlSeconds };
      return (req, res) => {
        void (async () => {
          let body = req.body;
          if (body === undefined) {
            let read;
            try {
              read = await readRawBody(req, SESSION_BODY_MAX_BYTES);
            } catch (error) {
              if (error instanceof BodyTooLargeError) {
                res.setHeader('connection', 'close');
                sendJson(res, 413, { error: 'payload_too_large' });
                return;
              }
              throw error;
            }
            body =
              read.status === 'read'
                ? parseJsonBody(read.body, headerOf(req, 'content-type'))
                : undefined;
          }
          const result = await host.sessionRoute(
            {
              user: await options.getUser(req),
              contentType: headerOf(req, 'content-type'),
              origin: headerOf(req, 'origin'),
              body,
            },
            routeOptions,
          );
          sendJson(res, result.status, result.body);
        })().catch((error: unknown) => {
          host.reportError(error);
          if (!res.headersSent) sendJson(res, 500, SESSION_UNAVAILABLE_BODY);
        });
      };
    },
  };
}
