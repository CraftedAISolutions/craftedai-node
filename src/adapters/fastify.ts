import type { IncomingMessage, ServerResponse } from 'node:http';
import { assertSessionHandlerOptions, type SessionHandlerOptions } from '../session.js';
import { failureBody, type CraftedAIRequestContext } from '../verify.js';
import { assertMaxBodyBytes, audienceUrl, MAX_BODY_BYTES } from './audience.js';
import {
  SESSION_UNAVAILABLE_BODY,
  VERIFICATION_UNAVAILABLE_BODY,
  type AdapterHost,
} from './host.js';
import { parseJsonBody } from './node-body.js';

/** The parts of a Fastify instance/request/reply the adapter uses (fastify is not a dependency). */
export interface FastifyLikeRequest {
  raw: IncomingMessage;
  method: string;
  url: string;
  protocol: string;
  host: string;
  headers: IncomingMessage['headers'];
  body: unknown;
}
export interface FastifyLikeReply {
  code(status: number): this;
  header(name: string, value: string): this;
  send(payload: unknown): this;
  raw: ServerResponse;
}
export interface FastifyLikeInstance {
  addContentTypeParser(
    contentType: string,
    options: { parseAs: 'buffer'; bodyLimit?: number },
    parser: (
      request: FastifyLikeRequest,
      body: Buffer,
      done: (err: Error | null, body?: unknown) => void,
    ) => void,
  ): void;
  removeAllContentTypeParsers(): void;
  addHook(
    name: 'preHandler',
    hook: (request: FastifyLikeRequest, reply: FastifyLikeReply) => Promise<unknown>,
  ): void;
}

/** Raw bytes and the verified context, kept per request (no Fastify decorators needed). */
const rawBodies = new WeakMap<object, Buffer>();
const contexts = new WeakMap<object, CraftedAIRequestContext>();

export interface FastifyProtectOptions {
  /** The MCP URL(s) exactly as registered in CraftedAI. Set it behind a proxy (spec §12.1). */
  publicUrl?: string | readonly string[];
  /** Largest request body Fastify buffers in this scope; larger is answered 413. Default 1 MiB. */
  maxBodyBytes?: number;
}

export interface FastifyAdapter {
  /**
   * Guard every route in this (encapsulated) scope:
   *   await app.register(async (mcp) => { craftedai.fastify.protect(mcp); mcp.post('/mcp', handler) })
   * Replaces the scope's body parsers with one that keeps the exact bytes, then
   * verifies in `preHandler`. Read the result with `craftedai.fastify.context(request)`.
   *
   * The audience is `request.protocol://request.host/path` without the query string, as
   * Fastify reports it (`X-Forwarded-*` count only if you enabled Fastify's `trustProxy`).
   * Behind a proxy, set `publicUrl`. A verification that itself fails (replay store down)
   * answers 500 `craftedai_verification_unavailable`, calls `onError`, and never reaches
   * your handler.
   */
  protect(instance: FastifyLikeInstance, options?: FastifyProtectOptions): void;
  context(request: FastifyLikeRequest): CraftedAIRequestContext | undefined;
  /** `ttlSeconds` is validated here, when the handler is built. */
  sessionHandler(
    options: SessionHandlerOptions<FastifyLikeRequest>,
  ): (request: FastifyLikeRequest, reply: FastifyLikeReply) => Promise<FastifyLikeReply>;
}

const header = (request: FastifyLikeRequest, name: string): string | undefined => {
  const value = request.headers[name];
  return Array.isArray(value) ? value.join(', ') : value;
};

export function createFastifyAdapter(host: AdapterHost): FastifyAdapter {
  return {
    protect(instance, options = {}) {
      const maxBodyBytes = options.maxBodyBytes ?? MAX_BODY_BYTES;
      assertMaxBodyBytes(maxBodyBytes);
      instance.removeAllContentTypeParsers();
      // Fastify hands the parser its own request object (not `request.raw`).
      instance.addContentTypeParser(
        '*',
        { parseAs: 'buffer', bodyLimit: maxBodyBytes },
        (request, body, done) => {
          rawBodies.set(request, body);
          done(
            null,
            parseJsonBody(body.length === 0 ? null : body, header(request, 'content-type')),
          );
        },
      );
      instance.addHook('preHandler', async (request, reply) => {
        try {
          const body = rawBodies.get(request) ?? null;
          const result = await host.verifyRaw(
            {
              method: request.method,
              url: audienceUrl(request.protocol, request.host, request.url),
              header: (name) => header(request, name),
              body: body === null || body.length === 0 ? null : body,
            },
            options.publicUrl,
          );
          if (!result.ok) {
            return reply.code(401).header('cache-control', 'no-store').send(failureBody(result));
          }
          contexts.set(request, result.context);
          return undefined;
        } catch (error) {
          // Fail closed: the error (which may carry a connection string) goes to onError, never
          // to Fastify's default handler, and the route handler is not reached.
          host.reportError(error);
          return reply
            .code(500)
            .header('cache-control', 'no-store')
            .send(VERIFICATION_UNAVAILABLE_BODY);
        }
      });
    },

    context(request) {
      return contexts.get(request);
    },

    sessionHandler(options) {
      assertSessionHandlerOptions(options);
      const routeOptions = { agentIds: options.agentIds, ttlSeconds: options.ttlSeconds };
      return async (request, reply) => {
        try {
          const result = await host.sessionRoute(
            {
              user: await options.getUser(request),
              contentType: header(request, 'content-type'),
              origin: header(request, 'origin'),
              body: request.body,
            },
            routeOptions,
          );
          return reply.code(result.status).header('cache-control', 'no-store').send(result.body);
        } catch (error) {
          host.reportError(error);
          return reply.code(500).header('cache-control', 'no-store').send(SESSION_UNAVAILABLE_BODY);
        }
      };
    },
  };
}
