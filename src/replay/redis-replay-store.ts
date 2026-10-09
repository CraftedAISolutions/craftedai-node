import type { RecordRequestInput, RecordRequestOutcome, ReplayStore } from './replay-store.js';

/**
 * The subset of an ioredis client this store calls. `ioredis` is not a
 * dependency: pass your own client. For node-redis v4+, wrap it:
 *
 *   const client = {
 *     get: (k) => redis.get(k),
 *     set: (k, v, _px, ttl, _nx) => redis.set(k, v, { PX: ttl, NX: true }),
 *     eval: (script, _n, ...args) =>
 *       redis.eval(script, { keys: args.slice(0, _n), arguments: args.slice(_n) }),
 *   };
 *
 * Every write the store makes is one atomic Redis command or one Lua script,
 * so concurrent instances cannot interleave a check with its write.
 */
export interface RedisLikeClient {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, px: 'PX', milliseconds: number, nx: 'NX'): Promise<unknown>;
  eval(script: string, numKeys: number, ...keysAndArgs: string[]): Promise<unknown>;
}

/** INCR, and on first creation pin the expiry (EXPIREAT), atomically. */
export const INCREMENT_SCRIPT =
  "local n = redis.call('INCR', KEYS[1]) if n == 1 then redis.call('EXPIREAT', KEYS[1], ARGV[1]) end return n";

/**
 * Record a delegated request: refuse when the jti exists (1) or the delegation
 * counter has reached its limit (2), else SET the jti and count one use (0).
 * Writes happen only on the 0 path, in the same script run, so Redis applies
 * the check and both writes as one step.
 *
 * KEYS[1] request jti, KEYS[2] delegation counter.
 * ARGV[1] jti TTL ms, ARGV[2] delegation expiry (unix ms), ARGV[3] limit.
 */
export const RECORD_REQUEST_SCRIPT = [
  "if redis.call('EXISTS', KEYS[1]) == 1 then return 1 end",
  "local uses = tonumber(redis.call('GET', KEYS[2]) or '0')",
  'if uses >= tonumber(ARGV[3]) then return 2 end',
  "redis.call('SET', KEYS[1], '1', 'PX', ARGV[1])",
  "local n = redis.call('INCR', KEYS[2])",
  "if n == 1 then redis.call('PEXPIREAT', KEYS[2], ARGV[2]) end",
  'return 0',
].join(' ');

const OUTCOMES: Record<number, RecordRequestOutcome> = {
  0: 'recorded',
  1: 'replayed',
  2: 'delegation_exhausted',
};

export interface RedisReplayStoreOptions {
  /** Key prefix. Default `craftedai:replay:`. */
  prefix?: string;
  /** Unix milliseconds; used to turn an absolute expiry into a TTL. */
  now?: () => number;
}

class RedisReplayStore implements ReplayStore {
  private readonly prefix: string;
  private readonly now: () => number;

  constructor(
    private readonly client: RedisLikeClient,
    options: RedisReplayStoreOptions,
  ) {
    this.prefix = options.prefix ?? 'craftedai:replay:';
    this.now = options.now ?? Date.now;
  }

  async has(key: string): Promise<boolean> {
    return (await this.client.get(this.prefix + key)) !== null;
  }

  async markOnce(key: string, expiresAtSeconds: number): Promise<boolean> {
    return (
      (await this.client.set(this.prefix + key, '1', 'PX', this.ttlMs(expiresAtSeconds), 'NX')) ===
      'OK'
    );
  }

  async count(key: string): Promise<number> {
    const raw = await this.client.get(this.prefix + key);
    return raw === null ? 0 : Number.parseInt(raw, 10);
  }

  async increment(key: string, expiresAtSeconds: number): Promise<number> {
    const result = await this.client.eval(
      INCREMENT_SCRIPT,
      1,
      this.prefix + key,
      String(expiresAtSeconds),
    );
    return Number(result);
  }

  async recordRequest(input: RecordRequestInput): Promise<RecordRequestOutcome> {
    const { jtiKey, jtiExpiresAtSeconds, delegation } = input;
    if (delegation === undefined) {
      return (await this.markOnce(jtiKey, jtiExpiresAtSeconds)) ? 'recorded' : 'replayed';
    }
    const reply = await this.client.eval(
      RECORD_REQUEST_SCRIPT,
      2,
      this.prefix + jtiKey,
      this.prefix + delegation.key,
      String(this.ttlMs(jtiExpiresAtSeconds)),
      String(delegation.expiresAtSeconds * 1000),
      String(delegation.limit),
    );
    const outcome = typeof reply === 'number' ? OUTCOMES[reply] : undefined;
    // Fail closed: a reply we cannot read must never be treated as "recorded".
    if (outcome === undefined) throw new Error('replay store: unexpected reply from Redis script');
    return outcome;
  }

  /** Milliseconds until `expiresAtSeconds`, never below 1 s. */
  private ttlMs(expiresAtSeconds: number): number {
    return Math.max(1_000, expiresAtSeconds * 1000 - this.now());
  }
}

/**
 * Replay store shared by every instance of a multi-instance MCP (spec §5.2
 * rule 6, §5.4). With a delegation, `recordRequest` touches two keys in one
 * script: on Redis Cluster those keys must hash to the same slot, otherwise
 * use a standalone or Sentinel deployment.
 */
export function redisReplayStore(
  client: RedisLikeClient,
  options: RedisReplayStoreOptions = {},
): ReplayStore {
  return new RedisReplayStore(client, options);
}
