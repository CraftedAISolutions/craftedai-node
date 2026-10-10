import { createExpressAdapter, type ExpressAdapter } from './adapters/express.js';
import { createFastifyAdapter, type FastifyAdapter } from './adapters/fastify.js';
import { createFetchAdapter, type FetchAdapter } from './adapters/fetch.js';
import { assertMaxBodyBytes, MAX_BODY_BYTES, stripQuery } from './adapters/audience.js';
import { readCappedBody, TOO_LARGE } from './adapters/fetch-body.js';
import { createAdapterHost, FETCH_CONSUMED_BODY_HINT } from './adapters/host.js';
import {
  INSPECT_CUSTOM,
  requireAppSecret,
  redactConfig,
  requireOrgId,
  requireSecretKey,
  resolveConfig,
  type CraftedAIOptions,
  type ResolvedConfig,
} from './config.js';
import { CraftedAIError } from './errors.js';
import { cspDirectives, formatCspDirectives, type CspDirectives } from './csp.js';
import { JwksCache } from './jwks-cache.js';
import { MemoryReplayStore } from './replay/memory-replay-store.js';
import type { ReplayStore } from './replay/replay-store.js';
import {
  createSession,
  revokeSessions,
  type CreateSessionInput,
  type EmbedSessionBoot,
} from './session.js';
import { verifyRawRequest, type RawRequest, type VerifyResult } from './verify.js';

/**
 * The library's one entry point (spec §4.2, §8).
 *
 *   const craftedai = new CraftedAI(); // reads CRAFTEDAI_SECRET_KEY, CRAFTEDAI_APP_SECRET, CRAFTEDAI_ORG_ID
 *
 * Construction validates what is present and throws `CraftedAIError('config_invalid')`
 * for a malformed origin or app secret, the published test-vector app secret, or
 * `requireDelegation` (the default) without an app secret. It does not throw for a
 * missing `CRAFTEDAI_SECRET_KEY` or `CRAFTEDAI_ORG_ID` (an MCP-only service has no
 * key): each operation checks what it needs and throws `config_missing`.
 *
 * A verifier failure is never swallowed: when the replay store (or your `now`) throws,
 * `verifyMcpRequest` rejects, so a caller cannot read an outage as a pass. The adapters answer
 * 503 `craftedai_verification_unavailable` with `Retry-After: 5` and call `onError`.
 * A signing-key fetch that fails is not an outage of that kind: it answers `unknown_key`.
 */
export class CraftedAI {
  readonly config: ResolvedConfig;
  /** Express guard and session route: `craftedai.express.verifyRequest()`. */
  readonly express: ExpressAdapter;
  /** Fastify guard and session route: `craftedai.fastify.protect(instance)`. */
  readonly fastify: FastifyAdapter;
  /** Web-standard guard and session route (Next.js, Remix, Hono, Bun, Deno). */
  readonly fetch: FetchAdapter;
  // Everything the integrator hands in (replay store, which may wrap an authenticated Redis
  // client; fetch; clock; onError) lives in `#private` fields: no spread, `Object.keys`,
  // `util.inspect({ showHidden })` or serializer can reach it.
  readonly #fetchImpl: typeof fetch;
  readonly #now: () => number;
  readonly #replay: ReplayStore;
  readonly #jwks: JwksCache;

  constructor(options: CraftedAIOptions = {}) {
    this.config = resolveConfig(options);
    this.#fetchImpl = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
    this.#now = options.now ?? Date.now;
    this.#replay = options.replayStore ?? new MemoryReplayStore({ now: this.#now });
    // Never `allowTestVectorKeys` or `maxStalenessMs`: those are test-only seams of JwksCache.
    this.#jwks = new JwksCache({
      apiOrigin: this.config.apiOrigin,
      fetch: this.#fetchImpl,
      now: this.#now,
    });
    // The adapters get bound closures, never the client: they cannot reach the integrator's objects.
    const host = createAdapterHost({
      verifyRaw: (request, publicUrl) => this.#verifyRaw(request, publicUrl),
      verifyMcpRequest: (request, verifyOptions) => this.verifyMcpRequest(request, verifyOptions),
      createSession: (input) => this.createSession(input),
      onError: options.onError ?? (() => undefined),
    });
    this.express = createExpressAdapter(host);
    this.fastify = createFastifyAdapter(host);
    this.fetch = createFetchAdapter(host);
  }

  /** Mint an embed session for a signed-in user (spec §5.3, §5.5). Web app only. */
  async createSession(input: CreateSessionInput): Promise<EmbedSessionBoot> {
    return createSession(input, {
      apiOrigin: this.config.apiOrigin,
      secretKey: requireSecretKey(this.config),
      appSecret: requireAppSecret(this.config),
      orgId: requireOrgId(this.config),
      fetch: this.#fetchImpl,
      now: this.#now,
    });
  }

  /** Revoke the user's live embed session — call it on logout. Web app only. */
  async revokeSessions(externalUserId: string): Promise<void> {
    return revokeSessions(externalUserId, {
      apiOrigin: this.config.apiOrigin,
      secretKey: requireSecretKey(this.config),
      fetch: this.#fetchImpl,
    });
  }

  /**
   * Verify a signed MCP request (spec §5.2) from a fetch `Request`. Reads the
   * body from a clone, so the original stays readable for your handler. The audience is
   * `request.url` without its query string or fragment (core-api's `aud` is the stored
   * endpoint URL); `X-Forwarded-*` is never read, so behind a proxy pass `publicUrl`.
   *
   * The body is read up to `maxBodyBytes` (default 1 MiB), a declared `Content-Length` over the
   * cap first, then the streamed bytes. Past the cap it rejects with
   * `CraftedAIError('payload_too_large')`: a `VerifyResult` cannot carry a 413, so a caller
   * using this method directly catches that code and answers 413 (`craftedai.fetch` does it
   * for you). An invalid `maxBodyBytes` rejects with `config_invalid`. A request whose body was
   * already read cannot be verified: it resolves `body_mismatch`.
   */
  async verifyMcpRequest(
    request: Request,
    options: { publicUrl?: string | readonly string[]; maxBodyBytes?: number } = {},
  ): Promise<VerifyResult> {
    const maxBodyBytes = options.maxBodyBytes ?? MAX_BODY_BYTES;
    assertMaxBodyBytes(maxBodyBytes);
    if (request.bodyUsed) {
      return { ok: false, reason: 'body_mismatch', message: FETCH_CONSUMED_BODY_HINT };
    }
    const bytes = await readCappedBody(request, maxBodyBytes);
    if (bytes === TOO_LARGE) {
      throw new CraftedAIError(
        'payload_too_large',
        `the request body is over the ${String(maxBodyBytes)}-byte limit`,
      );
    }
    return this.#verifyRaw(
      {
        method: request.method,
        url: stripQuery(request.url),
        header: (name) => request.headers.get(name) ?? undefined,
        body: bytes === null || bytes.length === 0 ? null : bytes,
      },
      options.publicUrl,
    );
  }

  /** Adapter plumbing, deliberately `#private`: it is not part of the public API. */
  async #verifyRaw(
    request: RawRequest,
    publicUrl?: string | readonly string[],
  ): Promise<VerifyResult> {
    const accepted =
      publicUrl === undefined
        ? this.config.publicUrl
        : typeof publicUrl === 'string'
          ? [publicUrl]
          : publicUrl;
    return verifyRawRequest(request, {
      apiOrigin: this.config.apiOrigin,
      orgId: requireOrgId(this.config),
      appSecret: this.config.appSecret,
      previousAppSecret: this.config.previousAppSecret,
      requireDelegation: this.config.requireDelegation,
      delegationCallLimit: this.config.delegationCallLimit,
      publicUrl: accepted,
      jwks: this.#jwks,
      replay: this.#replay,
      now: this.#now,
    });
  }

  /** `{ 'script-src': [chatOrigin], 'frame-src': [chatOrigin] }` — merge into your CSP. */
  cspDirectives(): CspDirectives {
    return cspDirectives(this.config.chatOrigin);
  }

  /** `JSON.stringify(client)` and logging frameworks: the config with every secret redacted. */
  toJSON(): Record<string, unknown> {
    return { config: redactConfig(this.config) };
  }

  /** `console.log(client)` / `util.inspect(client)`: the same redacted view, never a secret. */
  [INSPECT_CUSTOM](): Record<string, unknown> {
    return this.toJSON();
  }

  /** The same two directives as CSP text: `script-src X; frame-src X;`. */
  cspDirectiveString(): string {
    return formatCspDirectives(this.cspDirectives());
  }
}
