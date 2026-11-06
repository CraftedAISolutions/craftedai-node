import { inspect } from 'node:util';
import { describe, expect, it, vi } from 'vitest';
import { APP_SECRET, ORG_ID } from '../test/helpers/core-api-stub.js';
import { printed } from '../test/helpers/printed.js';
import { CraftedAI } from './craftedai.js';
import { MemoryReplayStore } from './replay/memory-replay-store.js';
import type { ReplayStore } from './replay/replay-store.js';

/** Stands in for `redisReplayStore(new Redis({ password }))`: a store that holds a credential. */
class AuthenticatedStore implements ReplayStore {
  readonly connection = { host: 'redis.internal', password: 'hunter2' };
  readonly #inner = new MemoryReplayStore();
  has = (key: string) => this.#inner.has(key);
  markOnce = (key: string, exp: number) => this.#inner.markOnce(key, exp);
  count = (key: string) => this.#inner.count(key);
  increment = (key: string, exp: number) => this.#inner.increment(key, exp);
  recordRequest: ReplayStore['recordRequest'] = (input) => this.#inner.recordRequest(input);
}

/** Every object reachable through own properties (enumerable or not, symbols, accessors' functions). */
function reachable(root: unknown): Set<unknown> {
  const seen = new Set<unknown>();
  const visit = (value: unknown): void => {
    if ((typeof value !== 'object' && typeof value !== 'function') || value === null) return;
    if (seen.has(value)) return;
    seen.add(value);
    for (const key of Reflect.ownKeys(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      visit(descriptor?.value);
      visit(descriptor?.get);
      visit(descriptor?.set);
    }
    visit(Object.getPrototypeOf(value));
  };
  visit(root);
  return seen;
}

describe('integrator-supplied objects stay private (review correction 5)', () => {
  const store = new AuthenticatedStore();
  const fetchImpl = vi.fn() as unknown as typeof fetch;
  const now = vi.fn(() => 1_790_000_000_000);
  const onError = vi.fn();
  const client = new CraftedAI({
    orgId: ORG_ID,
    appSecret: APP_SECRET,
    env: {},
    replayStore: store,
    fetch: fetchImpl,
    now,
    onError,
  });

  it('exposes only config and the three adapters as own properties', () => {
    expect(Reflect.ownKeys(client).sort()).toEqual(['config', 'express', 'fastify', 'fetch']);
    expect(Object.keys({ ...client }).sort()).toEqual(['config', 'express', 'fastify', 'fetch']);
  });

  it('reaches none of the integrator objects from the client, a spread of it, or its adapters', () => {
    const integrator = [store, store.connection, fetchImpl, now, onError];
    for (const root of [client, { ...client }]) {
      const graph = reachable(root);
      for (const object of integrator) expect(graph.has(object)).toBe(false);
    }
  });

  it('prints no credential from the replay store under any inspection', () => {
    const outputs = {
      ...printed(client),
      'inspect(client, depth null, showHidden, customInspect false)': inspect(client, {
        depth: null,
        showHidden: true,
        customInspect: false,
      }),
      'inspect({ ...client }, depth null, showHidden)': inspect(
        { ...client },
        { depth: null, showHidden: true },
      ),
      'inspect(adapters, depth null, showHidden)': inspect(
        [client.express, client.fastify, client.fetch],
        { depth: null, showHidden: true },
      ),
    };
    for (const [how, text] of Object.entries(outputs)) {
      expect(text, how).not.toContain('hunter2');
      expect(text, how).not.toContain('redis.internal');
    }
  });
});
