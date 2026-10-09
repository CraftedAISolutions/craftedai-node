import { parsePublicSigningJwk, type PublicSigningJwk } from './claims.js';
import {
  JWKS_CACHE_MAX_AGE_SECONDS,
  JWKS_PATH,
  JWKS_UNKNOWN_KID_REFETCH_MIN_INTERVAL_SECONDS,
  TEST_VECTOR_KIDS,
} from './contract.js';

/**
 * Hard ceiling on how long last-good keys are served while the JWKS cannot be
 * refreshed: 24 h after the last SUCCESSFUL fetch. Past it, `lookup` answers
 * `unavailable` and never returns a stale key (a revoked key must not stay
 * trusted through an outage).
 */
export const JWKS_MAX_STALENESS_MS = 24 * 60 * 60 * 1000;

export interface JwksCacheOptions {
  /** The API origin (`iss`); the JWKS is `{apiOrigin}/.well-known/jwks.json`. */
  apiOrigin: string;
  fetch: typeof fetch;
  /** Unix milliseconds. */
  now: () => number;
  /** Per-fetch timeout. Default 5 s. */
  timeoutMs?: number;
  /**
   * @internal
   * TEST ONLY. The published test-vector keys (`TEST_VECTOR_KIDS`) have private
   * keys derived from public seeds, so by default the cache refuses to serve
   * them even if the JWKS lists them. Set this only to run the shared vectors.
   */
  allowTestVectorKeys?: boolean;
  /**
   * @internal
   * TEST ONLY. Overrides `JWKS_MAX_STALENESS_MS`.
   */
  maxStalenessMs?: number;
}

/**
 * `unknown` and `unavailable` both map to the verification reason `unknown_key`
 * (fail closed: no key is ever accepted that was not fetched and validated);
 * `message` says which, and never contains the caller's `kid` or response data.
 */
export type JwksLookup =
  | { status: 'found'; jwk: PublicSigningJwk }
  | { status: 'unknown'; message: string }
  | { status: 'unavailable'; message: string };

const MAX_KID_LENGTH = 128;

/**
 * Spec §5.2 rule 1: keys are cached for `max-age` (300 s); an unknown `kid`
 * triggers one refetch, at most once every 30 s, so a flood of forged kids
 * cannot turn the MCP into a JWKS amplifier. Concurrent misses share one fetch.
 * The 30 s throttle applies to failed fetches too. A failed refetch keeps
 * serving the last good key set; with none, every lookup is `unavailable`.
 *
 * Every key is validated with the strict contract mirror (OKP/Ed25519, no
 * private member); invalid keys, kids listed twice, and the published
 * test-vector keys (unless explicitly allowed) are dropped.
 *
 * Precondition: `lookup` is asked about a well-formed `kid` only (the verifier
 * validates the JOSE header first; a missing, empty or oversized kid is
 * `bad_signature`, never `unknown_key`). As defence in depth, a malformed kid
 * is answered `unknown` without touching the network.
 */
export class JwksCache {
  private keys: PublicSigningJwk[] | null = null;
  private fetchedAtMs = Number.NEGATIVE_INFINITY;
  private lastAttemptMs = Number.NEGATIVE_INFINITY;
  private lastFailure = 'JWKS has not been fetched';
  private inflight: Promise<void> | null = null;
  readonly url: string;

  constructor(private readonly options: JwksCacheOptions) {
    this.url = `${options.apiOrigin.replace(/\/+$/, '')}${JWKS_PATH}`;
  }

  async lookup(kid: string): Promise<JwksLookup> {
    if (typeof kid !== 'string' || kid.length === 0 || kid.length > MAX_KID_LENGTH) {
      return { status: 'unknown', message: 'malformed key id' };
    }
    // A negative age means the wall clock went back past the last successful fetch:
    // the keys' real age is unknown, so they are stale and must be refetched.
    const ageMs = this.options.now() - this.fetchedAtMs;
    const stale = ageMs < 0 || ageMs >= JWKS_CACHE_MAX_AGE_SECONDS * 1000;
    if (stale && this.mayRefetch()) await this.refresh();
    let jwk = this.find(kid);
    if (jwk === undefined && this.mayRefetch()) {
      await this.refresh();
      jwk = this.find(kid);
    }
    const keysAgeMs = this.options.now() - this.fetchedAtMs;
    // Still negative after the refetch attempt (it failed or was throttled): fail closed.
    if (
      this.keys !== null &&
      (keysAgeMs < 0 || keysAgeMs > (this.options.maxStalenessMs ?? JWKS_MAX_STALENESS_MS))
    ) {
      return { status: 'unavailable', message: `JWKS keys are stale: ${this.lastFailure}` };
    }
    if (jwk !== undefined) return { status: 'found', jwk };
    if (this.keys === null) return { status: 'unavailable', message: this.lastFailure };
    return { status: 'unknown', message: 'no key with this key id in the JWKS' };
  }

  /**
   * Every fetch — stale refresh or unknown kid — is throttled to one per 30 s,
   * successful or not; a caller arriving while a fetch is in flight joins it instead.
   */
  private mayRefetch(): boolean {
    if (this.inflight !== null) return true;
    const sinceLastAttemptMs = this.options.now() - this.lastAttemptMs;
    // A negative value means the wall clock went backwards: treat the throttle as
    // elapsed, otherwise fetching would stall until the clock catches up.
    return (
      sinceLastAttemptMs < 0 ||
      sinceLastAttemptMs >= JWKS_UNKNOWN_KID_REFETCH_MIN_INTERVAL_SECONDS * 1000
    );
  }

  private find(kid: string): PublicSigningJwk | undefined {
    return this.keys?.find((key) => key.kid === kid);
  }

  private refresh(): Promise<void> {
    this.inflight ??= this.load().finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  private async load(): Promise<void> {
    this.lastAttemptMs = this.options.now();
    try {
      const response = await this.options.fetch(this.url, {
        headers: { accept: 'application/json' },
        redirect: 'error',
        signal: AbortSignal.timeout(this.options.timeoutMs ?? 5_000),
      });
      if (!response.ok) {
        this.lastFailure = `JWKS fetch failed: HTTP ${response.status}`;
        // Release the socket (an unread body keeps the connection busy in undici), without
        // waiting: a custom fetch whose cancel() never settles must not hold the in-flight slot.
        try {
          void response.body?.cancel().catch(() => undefined);
        } catch {
          // Nothing to do: the response is being discarded either way.
        }
        return;
      }
      const body: unknown = await response.json();
      const rawKeys: unknown =
        typeof body === 'object' && body !== null ? (body as { keys?: unknown }).keys : undefined;
      if (!Array.isArray(rawKeys)) {
        this.lastFailure = 'JWKS response malformed';
        return;
      }
      this.keys = this.acceptable(rawKeys);
      this.fetchedAtMs = this.options.now();
    } catch (error) {
      // Network error, timeout or bad JSON: keep the last good key set (or none).
      this.lastFailure =
        error instanceof SyntaxError ? 'JWKS response malformed' : 'JWKS unreachable';
    }
  }

  private acceptable(rawKeys: unknown[]): PublicSigningJwk[] {
    const valid = rawKeys
      .map((key) => parsePublicSigningJwk(key))
      .filter((key): key is PublicSigningJwk => key !== null);
    const counts = new Map<string, number>();
    for (const { kid } of valid) counts.set(kid, (counts.get(kid) ?? 0) + 1);
    return valid.filter(
      ({ kid }) =>
        counts.get(kid) === 1 &&
        (this.options.allowTestVectorKeys === true || !TEST_VECTOR_KIDS.includes(kid)),
    );
  }
}
