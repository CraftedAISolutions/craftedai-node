import { describe, expect, it } from 'vitest';
import {
  INCREMENT_SCRIPT,
  RECORD_REQUEST_SCRIPT,
  redisReplayStore,
  type RedisLikeClient,
} from './redis-replay-store.js';

const NOW_S = 1_790_000_000;

/**
 * In-memory double of the three ioredis calls, recording what was sent. It
 * cannot run Lua, so `eval` answers `evalReply` for the record script and
 * emulates INCR for the increment script; the real semantics are proven
 * against a live Redis in the integration test.
 */
function fakeRedis(evalReply?: unknown) {
  const data = new Map<string, string>();
  const calls: unknown[][] = [];
  const client: RedisLikeClient = {
    get: (key) => Promise.resolve(data.get(key) ?? null),
    set: (key, value, ...args) => {
      calls.push(['set', key, value, ...args]);
      if (data.has(key)) return Promise.resolve(null);
      data.set(key, value);
      return Promise.resolve('OK');
    },
    eval: (script, numKeys, ...args) => {
      calls.push(['eval', script, numKeys, ...args]);
      if (evalReply !== undefined) return Promise.resolve(evalReply);
      const key = args[0] ?? '';
      const next = Number(data.get(key) ?? '0') + 1;
      data.set(key, String(next));
      return Promise.resolve(next);
    },
  };
  return { client, calls };
}

describe('redisReplayStore', () => {
  it('marks with SET NX PX ttl, prefixed', async () => {
    const { client, calls } = fakeRedis();
    const store = redisReplayStore(client, { now: () => NOW_S * 1000 });
    expect(await store.markOnce('j1', NOW_S + 60)).toBe(true);
    expect(await store.markOnce('j1', NOW_S + 60)).toBe(false);
    expect(await store.has('j1')).toBe(true);
    expect(calls[0]).toEqual(['set', 'craftedai:replay:j1', '1', 'PX', 60_000, 'NX']);
  });

  it('increments through the atomic INCR+PEXPIRE script, with a ms TTL from the verifier clock', async () => {
    const { client, calls } = fakeRedis();
    const store = redisReplayStore(client, { prefix: 'p:', now: () => NOW_S * 1000 });
    expect(await store.increment('d1', NOW_S + 300)).toBe(1);
    expect(await store.increment('d1', NOW_S + 300)).toBe(2);
    expect(await store.count('d1')).toBe(2);
    expect(calls[0]).toEqual(['eval', INCREMENT_SCRIPT, 1, 'p:d1', '300000']);
    expect(INCREMENT_SCRIPT).toContain('PEXPIRE');
    expect(INCREMENT_SCRIPT).not.toContain('AT');
  });

  it('never sets a TTL below 1 s', async () => {
    const { client, calls } = fakeRedis();
    await redisReplayStore(client, { now: () => NOW_S * 1000 }).markOnce('j', NOW_S - 5);
    expect(calls[0]?.[4]).toBe(1_000);
  });

  it('keeps millisecond precision in the TTL', async () => {
    const { client, calls } = fakeRedis();
    await redisReplayStore(client, { now: () => NOW_S * 1000 + 250 }).markOnce('j', NOW_S + 60);
    expect(calls[0]?.[4]).toBe(59_750);
  });

  describe('strict reply parsing', () => {
    const clientWith = (overrides: Partial<RedisLikeClient>): RedisLikeClient => ({
      get: () => Promise.resolve(null),
      set: () => Promise.resolve('OK'),
      eval: () => Promise.resolve(1),
      ...overrides,
    });

    it.each(['3', -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1, null, undefined, {}])(
      'increment rejects the reply %o',
      async (reply) => {
        const store = redisReplayStore(clientWith({ eval: () => Promise.resolve(reply) }));
        await expect(store.increment('d', NOW_S + 300)).rejects.toThrow(/unexpected/);
      },
    );

    it.each(['abc', '-1', '1.5', '2x', '', ' 3', '9007199254740993'])(
      'count rejects the stored value %j',
      async (raw) => {
        const store = redisReplayStore(clientWith({ get: () => Promise.resolve(raw) }));
        await expect(store.count('d')).rejects.toThrow(/unexpected/);
      },
    );

    it('count accepts a plain non-negative integer and treats a missing key as 0', async () => {
      expect(
        await redisReplayStore(clientWith({ get: () => Promise.resolve('7') })).count('d'),
      ).toBe(7);
      expect(await redisReplayStore(clientWith({})).count('d')).toBe(0);
    });
  });

  describe('recordRequest', () => {
    it('without delegation it is a single SET NX PX', async () => {
      const { client, calls } = fakeRedis();
      const store = redisReplayStore(client, { now: () => NOW_S * 1000 });
      const input = { jtiKey: 'req:j', jtiExpiresAtSeconds: NOW_S + 60 };
      expect(await store.recordRequest(input)).toBe('recorded');
      expect(await store.recordRequest(input)).toBe('replayed');
      expect(calls).toHaveLength(2);
      expect(calls[0]).toEqual(['set', 'craftedai:replay:req:j', '1', 'PX', 60_000, 'NX']);
    });

    it('with delegation it is one eval over both keys', async () => {
      const { client, calls } = fakeRedis(0);
      const store = redisReplayStore(client, { prefix: 'p:', now: () => NOW_S * 1000 });
      const outcome = await store.recordRequest({
        jtiKey: 'req:j',
        jtiExpiresAtSeconds: NOW_S + 60,
        delegation: { key: 'del:d', limit: 20, expiresAtSeconds: NOW_S + 300 },
      });
      expect(outcome).toBe('recorded');
      expect(calls).toEqual([
        ['eval', RECORD_REQUEST_SCRIPT, 2, 'p:req:j', 'p:del:d', '60000', '300000', '20'],
      ]);
    });

    it.each([
      [0, 'recorded'],
      [1, 'replayed'],
      [2, 'delegation_exhausted'],
    ])('maps script reply %s to %s', async (reply, expected) => {
      const { client } = fakeRedis(reply);
      const store = redisReplayStore(client, { now: () => NOW_S * 1000 });
      const outcome = await store.recordRequest({
        jtiKey: 'j',
        jtiExpiresAtSeconds: NOW_S + 60,
        delegation: { key: 'd', limit: 1, expiresAtSeconds: NOW_S + 300 },
      });
      expect(outcome).toBe(expected);
    });

    it('fails closed on a reply it does not understand', async () => {
      const { client } = fakeRedis('garbage');
      const store = redisReplayStore(client, { now: () => NOW_S * 1000 });
      await expect(
        store.recordRequest({
          jtiKey: 'j',
          jtiExpiresAtSeconds: NOW_S + 60,
          delegation: { key: 'd', limit: 1, expiresAtSeconds: NOW_S + 300 },
        }),
      ).rejects.toThrow(/unexpected/);
    });
  });
});
