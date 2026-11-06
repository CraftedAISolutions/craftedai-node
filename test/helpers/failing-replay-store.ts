import { MemoryReplayStore } from '../../src/replay/memory-replay-store.js';
import type { ReplayStore } from '../../src/replay/replay-store.js';

/** What a Redis outage throws: the message carries a password, to prove no adapter echoes it. */
export const OUTAGE_MESSAGE = 'connect ECONNREFUSED redis://:hunter2@10.0.0.5:6379';

/** A replay store whose `method` rejects, as a real store does when its backend is down. */
export function failingReplayStore(
  method: 'has' | 'recordRequest',
  failure: Error = new Error(OUTAGE_MESSAGE),
): ReplayStore {
  const healthy = new MemoryReplayStore();
  return {
    has: (key) => (method === 'has' ? Promise.reject(failure) : healthy.has(key)),
    markOnce: (key, exp) => healthy.markOnce(key, exp),
    count: (key) => healthy.count(key),
    increment: (key, exp) => healthy.increment(key, exp),
    recordRequest: (input) =>
      method === 'recordRequest' ? Promise.reject(failure) : healthy.recordRequest(input),
  };
}
