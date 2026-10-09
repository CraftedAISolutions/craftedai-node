import { randomUUID } from 'node:crypto';
import { Redis } from 'ioredis';
import { afterAll, describe, expect, it } from 'vitest';
import { redisReplayStore } from './redis-replay-store.js';

/** Real Redis (CI service). Skipped unless INTEGRATION_REDIS=1 and REDIS_URL are set. */
const enabled = process.env.INTEGRATION_REDIS === '1' && process.env.REDIS_URL !== undefined;

describe.runIf(enabled)('redisReplayStore against real Redis', () => {
  const url = process.env.REDIS_URL ?? '';
  const prefix = `test:${randomUUID()}:`;
  const a = new Redis(url);
  const b = new Redis(url);
  afterAll(async () => {
    await Promise.all([a.quit(), b.quit()]);
  });

  const expiry = (seconds: number) => Math.floor(Date.now() / 1000) + seconds;

  it('markOnce is once-only across two clients', async () => {
    const exp = expiry(60);
    const results = await Promise.all([
      redisReplayStore(a, { prefix }).markOnce('j', exp),
      redisReplayStore(b, { prefix }).markOnce('j', exp),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it('markOnce is once-only across many concurrent callers on both clients', async () => {
    const exp = expiry(60);
    const viaA = redisReplayStore(a, { prefix });
    const viaB = redisReplayStore(b, { prefix });
    const pick = (i: number) => (i % 2 === 0 ? viaA : viaB);
    const results = await Promise.all(
      Array.from({ length: 40 }, (_, i) => pick(i).markOnce('many', exp)),
    );
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it('markOnce sets a millisecond TTL that ends with the token', async () => {
    const exp = expiry(60);
    await redisReplayStore(a, { prefix }).markOnce('ttl', exp);
    const ms = await a.pttl(`${prefix}ttl`);
    expect(ms).toBeGreaterThan(58_000);
    expect(ms).toBeLessThanOrEqual(60_000);
  });

  it('increment counts 20 concurrent calls exactly and pins the expiry', async () => {
    const store = redisReplayStore(a, { prefix });
    const exp = expiry(300);
    const counts = await Promise.all(Array.from({ length: 20 }, () => store.increment('d', exp)));
    expect([...counts].sort((x, y) => x - y)).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
    expect(await a.ttl(`${prefix}d`)).toBeGreaterThan(290);
  });

  describe('verifier clock behind Redis', () => {
    // The verifier is 2 s behind Redis, and the delegation exp is already 1 s in
    // the past by Redis's clock. An absolute PEXPIREAT would delete the counter
    // at once and the limit would never hold; a TTL from the verifier's clock does.
    const behind = () => Date.now() - 2_000;
    const pastByRedis = () => Math.floor(Date.now() / 1000) - 1;

    it('recordRequest still counts uses and holds the limit', async () => {
      const store = redisReplayStore(a, { prefix, now: behind });
      const outcomes = await Promise.all(
        Array.from({ length: 5 }, (_, i) =>
          store.recordRequest({
            jtiKey: `req:skew${i}`,
            jtiExpiresAtSeconds: pastByRedis(),
            delegation: { key: 'del:skew', limit: 1, expiresAtSeconds: pastByRedis() },
          }),
        ),
      );
      expect(outcomes.filter((o) => o === 'recorded')).toHaveLength(1);
      expect(outcomes.filter((o) => o === 'delegation_exhausted')).toHaveLength(4);
      expect(await store.count('del:skew')).toBe(1);
    });

    it('increment keeps counting past 1', async () => {
      const store = redisReplayStore(a, { prefix, now: behind });
      expect(await store.increment('d:skew', pastByRedis())).toBe(1);
      expect(await store.increment('d:skew', pastByRedis())).toBe(2);
      expect(await store.count('d:skew')).toBe(2);
    });
  });

  describe('recordRequest', () => {
    it('same jti from two clients: exactly one recorded, the rest replayed, one use consumed', async () => {
      const viaA = redisReplayStore(a, { prefix });
      const viaB = redisReplayStore(b, { prefix });
      const pick = (i: number) => (i % 2 === 0 ? viaA : viaB);
      const input = {
        jtiKey: 'req:same',
        jtiExpiresAtSeconds: expiry(60),
        delegation: { key: 'del:same', limit: 20, expiresAtSeconds: expiry(300) },
      };
      const outcomes = await Promise.all(
        Array.from({ length: 30 }, (_, i) => pick(i).recordRequest(input)),
      );
      expect(outcomes.filter((o) => o === 'recorded')).toHaveLength(1);
      expect(outcomes.filter((o) => o === 'replayed')).toHaveLength(29);
      expect(await viaA.count('del:same')).toBe(1);
    });

    it('distinct jtis sharing a delegation never exceed the limit', async () => {
      const viaA = redisReplayStore(a, { prefix });
      const viaB = redisReplayStore(b, { prefix });
      const pick = (i: number) => (i % 2 === 0 ? viaA : viaB);
      const outcomes = await Promise.all(
        Array.from({ length: 12 }, (_, i) =>
          pick(i).recordRequest({
            jtiKey: `req:lim${i}`,
            jtiExpiresAtSeconds: expiry(60),
            delegation: { key: 'del:lim', limit: 5, expiresAtSeconds: expiry(300) },
          }),
        ),
      );
      expect(outcomes.filter((o) => o === 'recorded')).toHaveLength(5);
      expect(outcomes.filter((o) => o === 'delegation_exhausted')).toHaveLength(7);
      expect(await viaA.count('del:lim')).toBe(5);
    });

    it('a rejected request burns neither its jti nor a delegation use', async () => {
      const store = redisReplayStore(a, { prefix });
      const delegation = { key: 'del:burn', limit: 1, expiresAtSeconds: expiry(300) };
      expect(
        await store.recordRequest({
          jtiKey: 'req:b1',
          jtiExpiresAtSeconds: expiry(60),
          delegation,
        }),
      ).toBe('recorded');
      // Exhausted: the new jti must stay unburned.
      expect(
        await store.recordRequest({
          jtiKey: 'req:b2',
          jtiExpiresAtSeconds: expiry(60),
          delegation,
        }),
      ).toBe('delegation_exhausted');
      expect(await store.has('req:b2')).toBe(false);
      // Replayed: must not consume a use on a fresh delegation.
      const fresh = { key: 'del:burn2', limit: 5, expiresAtSeconds: expiry(300) };
      expect(
        await store.recordRequest({
          jtiKey: 'req:b1',
          jtiExpiresAtSeconds: expiry(60),
          delegation: fresh,
        }),
      ).toBe('replayed');
      expect(await store.count('del:burn2')).toBe(0);
    });

    it('pins the delegation expiry on first use only', async () => {
      const store = redisReplayStore(a, { prefix });
      await store.recordRequest({
        jtiKey: 'req:e1',
        jtiExpiresAtSeconds: expiry(60),
        delegation: { key: 'del:exp', limit: 20, expiresAtSeconds: expiry(300) },
      });
      await store.recordRequest({
        jtiKey: 'req:e2',
        jtiExpiresAtSeconds: expiry(60),
        delegation: { key: 'del:exp', limit: 20, expiresAtSeconds: expiry(9_000) },
      });
      const ttl = await a.ttl(`${prefix}del:exp`);
      expect(ttl).toBeGreaterThan(290);
      expect(ttl).toBeLessThanOrEqual(300);
    });

    it('without delegation it is once-only across clients', async () => {
      const input = { jtiKey: 'req:nodel', jtiExpiresAtSeconds: expiry(60) };
      const outcomes = await Promise.all([
        redisReplayStore(a, { prefix }).recordRequest(input),
        redisReplayStore(b, { prefix }).recordRequest(input),
      ]);
      expect(outcomes.filter((o) => o === 'recorded')).toHaveLength(1);
    });
  });
});
