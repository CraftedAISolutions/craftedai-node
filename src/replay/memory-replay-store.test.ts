import { describe, expect, it } from 'vitest';
import { CraftedAIError } from '../errors.js';
import { MemoryReplayStore } from './memory-replay-store.js';

const NOW_S = 1_790_000_000;

function store(maxEntries?: number) {
  let nowMs = NOW_S * 1000;
  const s = new MemoryReplayStore({ ...(maxEntries ? { maxEntries } : {}), now: () => nowMs });
  return { s, advance: (seconds: number) => (nowMs += seconds * 1000) };
}

describe('MemoryReplayStore', () => {
  describe('maxEntries validation', () => {
    it.each([1, 0, -5, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
      'rejects maxEntries %s with config_invalid',
      (maxEntries) => {
        expect(() => new MemoryReplayStore({ maxEntries })).toThrow(CraftedAIError);
        expect(() => new MemoryReplayStore({ maxEntries })).toThrow(
          expect.objectContaining({ code: 'config_invalid' }),
        );
      },
    );

    it('accepts 2 and the default, and a delegated record then fits at 2', async () => {
      expect(() => new MemoryReplayStore()).not.toThrow();
      const { s } = store(2);
      const outcome = await s.recordRequest({
        jtiKey: 'req:j',
        jtiExpiresAtSeconds: NOW_S + 60,
        delegation: { key: 'del:d', limit: 2, expiresAtSeconds: NOW_S + 300 },
      });
      expect(outcome).toBe('recorded');
      expect(await s.has('req:j')).toBe(true);
      expect(await s.count('del:d')).toBe(1);
    });
  });

  it('markOnce succeeds once per key until it expires', async () => {
    const { s, advance } = store();
    expect(await s.markOnce('j1', NOW_S + 60)).toBe(true);
    expect(await s.markOnce('j1', NOW_S + 60)).toBe(false);
    expect(await s.has('j1')).toBe(true);
    advance(60);
    expect(await s.has('j1')).toBe(false);
    expect(await s.markOnce('j1', NOW_S + 120)).toBe(true);
  });

  it('counts and keeps the first expiry', async () => {
    const { s, advance } = store();
    expect(await s.increment('d1', NOW_S + 300)).toBe(1);
    expect(await s.increment('d1', NOW_S + 9_999)).toBe(2);
    expect(await s.count('d1')).toBe(2);
    advance(300);
    expect(await s.count('d1')).toBe(0);
  });

  it('evicts expired entries before live ones when full', async () => {
    const { s, advance } = store(2);
    await s.markOnce('live', NOW_S + 600);
    await s.markOnce('old', NOW_S + 10);
    advance(20);
    await s.markOnce('new', NOW_S + 600);
    expect(await s.has('live')).toBe(true);
    expect(await s.has('new')).toBe(true);
    expect(s.size).toBe(2);
  });

  it('evicts the oldest live entry when full of live ones', async () => {
    const { s } = store(2);
    await s.markOnce('a', NOW_S + 600);
    await s.markOnce('b', NOW_S + 600);
    await s.markOnce('c', NOW_S + 600);
    expect(await s.has('a')).toBe(false);
    expect(await s.has('b')).toBe(true);
    expect(await s.has('c')).toBe(true);
  });

  describe('concurrency', () => {
    it('markOnce on the same key lets exactly one of many concurrent callers win', async () => {
      const { s } = store();
      const results = await Promise.all(
        Array.from({ length: 50 }, () => s.markOnce('same-jti', NOW_S + 60)),
      );
      expect(results.filter(Boolean)).toHaveLength(1);
    });

    it('increment hands out every count exactly once', async () => {
      const { s } = store();
      const counts = await Promise.all(
        Array.from({ length: 30 }, () => s.increment('d', NOW_S + 300)),
      );
      expect([...counts].sort((x, y) => x - y)).toEqual(
        Array.from({ length: 30 }, (_, i) => i + 1),
      );
    });

    it('recordRequest on the same jti yields exactly one recorded and the rest replayed', async () => {
      const { s } = store();
      const outcomes = await Promise.all(
        Array.from({ length: 20 }, () =>
          s.recordRequest({
            jtiKey: 'req:j',
            jtiExpiresAtSeconds: NOW_S + 60,
            delegation: { key: 'del:d', limit: 20, expiresAtSeconds: NOW_S + 300 },
          }),
        ),
      );
      expect(outcomes.filter((o) => o === 'recorded')).toHaveLength(1);
      expect(outcomes.filter((o) => o === 'replayed')).toHaveLength(19);
      // The losers did not consume delegation uses.
      expect(await s.count('del:d')).toBe(1);
    });

    it('recordRequest never lets concurrent requests overshoot the delegation limit', async () => {
      const { s } = store();
      const outcomes = await Promise.all(
        Array.from({ length: 10 }, (_, i) =>
          s.recordRequest({
            jtiKey: `req:j${i}`,
            jtiExpiresAtSeconds: NOW_S + 60,
            delegation: { key: 'del:d', limit: 3, expiresAtSeconds: NOW_S + 300 },
          }),
        ),
      );
      expect(outcomes.filter((o) => o === 'recorded')).toHaveLength(3);
      expect(outcomes.filter((o) => o === 'delegation_exhausted')).toHaveLength(7);
      expect(await s.count('del:d')).toBe(3);
    });
  });

  describe('recordRequest', () => {
    it('records the jti alone when there is no delegation', async () => {
      const { s } = store();
      const input = { jtiKey: 'req:j', jtiExpiresAtSeconds: NOW_S + 60 };
      expect(await s.recordRequest(input)).toBe('recorded');
      expect(await s.recordRequest(input)).toBe('replayed');
      expect(await s.has('req:j')).toBe(true);
    });

    it('records the jti and counts one delegation use together', async () => {
      const { s } = store();
      const outcome = await s.recordRequest({
        jtiKey: 'req:j',
        jtiExpiresAtSeconds: NOW_S + 60,
        delegation: { key: 'del:d', limit: 2, expiresAtSeconds: NOW_S + 300 },
      });
      expect(outcome).toBe('recorded');
      expect(await s.has('req:j')).toBe(true);
      expect(await s.count('del:d')).toBe(1);
    });

    it('a replayed request does not consume a delegation use', async () => {
      const { s } = store();
      await s.markOnce('req:j', NOW_S + 60);
      const outcome = await s.recordRequest({
        jtiKey: 'req:j',
        jtiExpiresAtSeconds: NOW_S + 60,
        delegation: { key: 'del:d', limit: 2, expiresAtSeconds: NOW_S + 300 },
      });
      expect(outcome).toBe('replayed');
      expect(await s.count('del:d')).toBe(0);
    });

    it('an exhausted delegation does not burn the request jti', async () => {
      const { s } = store();
      await s.increment('del:d', NOW_S + 300);
      const outcome = await s.recordRequest({
        jtiKey: 'req:j',
        jtiExpiresAtSeconds: NOW_S + 60,
        delegation: { key: 'del:d', limit: 1, expiresAtSeconds: NOW_S + 300 },
      });
      expect(outcome).toBe('delegation_exhausted');
      expect(await s.has('req:j')).toBe(false);
      expect(await s.count('del:d')).toBe(1);
    });

    it('reports replayed before delegation_exhausted, as the spec check order does', async () => {
      const { s } = store();
      await s.markOnce('req:j', NOW_S + 60);
      await s.increment('del:d', NOW_S + 300);
      const outcome = await s.recordRequest({
        jtiKey: 'req:j',
        jtiExpiresAtSeconds: NOW_S + 60,
        delegation: { key: 'del:d', limit: 1, expiresAtSeconds: NOW_S + 300 },
      });
      expect(outcome).toBe('replayed');
    });

    it('allows exactly `limit` uses of one delegation across distinct requests', async () => {
      const { s } = store();
      const outcomes: string[] = [];
      for (let i = 0; i < 4; i += 1) {
        outcomes.push(
          await s.recordRequest({
            jtiKey: `req:j${i}`,
            jtiExpiresAtSeconds: NOW_S + 60,
            delegation: { key: 'del:d', limit: 3, expiresAtSeconds: NOW_S + 300 },
          }),
        );
      }
      expect(outcomes).toEqual(['recorded', 'recorded', 'recorded', 'delegation_exhausted']);
    });
  });
});
