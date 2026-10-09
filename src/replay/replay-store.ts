/**
 * Where the verifier remembers request `jti`s (spec §5.2 rule 6) and counts
 * delegation uses (§5.3 ceiling). Entries live until `expiresAtSeconds` (unix s).
 *
 * The default in-memory store does not span processes: a multi-instance MCP
 * must pass `redisReplayStore(client)` (spec §5.4 known gap).
 *
 * Keys are opaque. The caller namespaces them (for example `req:<jti>` and
 * `del:<jti>`) so a request jti can never collide with a delegation jti.
 */
export interface ReplayStore {
  /** True when `key` was recorded and has not expired. */
  has(key: string): Promise<boolean>;
  /** Records `key` atomically. Resolves `false` when it already existed (lost a race). */
  markOnce(key: string, expiresAtSeconds: number): Promise<boolean>;
  /** Current counter value; 0 when absent or expired. */
  count(key: string): Promise<number>;
  /** Atomically increments the counter (creating it with this expiry) and resolves the new value. */
  increment(key: string, expiresAtSeconds: number): Promise<number>;
  /**
   * The verifier's one state write, after every other check has passed: record
   * the request jti and, when the request carries a delegation, count one use
   * of it, as a single atomic step. Nothing is written unless both succeed, so
   * a rejected request burns neither its jti nor a delegation use. A caller
   * that did `markOnce` then `increment` (or the reverse) would leave a window
   * in which two concurrent requests both pass, or one burns state it was
   * refused.
   *
   * Check order matches spec §5.2: `replayed` before `delegation_exhausted`.
   */
  recordRequest(input: RecordRequestInput): Promise<RecordRequestOutcome>;
}

export interface RecordRequestInput {
  /** Key for the request token's `jti`. */
  jtiKey: string;
  jtiExpiresAtSeconds: number;
  /** Present when the request is delegated (`act` claim, delegation required). */
  delegation?: {
    /** Key for the delegation token's `jti`. */
    key: string;
    /** Most uses allowed; a use is refused once the counter has reached it. */
    limit: number;
    /** Pinned on the first use only. */
    expiresAtSeconds: number;
  };
}

export type RecordRequestOutcome = 'recorded' | 'replayed' | 'delegation_exhausted';
