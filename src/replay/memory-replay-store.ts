import { CraftedAIError } from '../errors.js';
import type { RecordRequestInput, RecordRequestOutcome, ReplayStore } from './replay-store.js';

export interface MemoryReplayStoreOptions {
  /**
   * Most live entries kept; an integer >= 2 (a delegated request writes two
   * entries, and a limit of 1 would evict the jti it just recorded). When full,
   * expired entries are dropped first, then the oldest live one, which opens a
   * replay window. Request jtis live 60 s and delegation counters up to 300 s,
   * and both share this capacity, so at the default the window opens above
   * ~1,300 requests/s when delegations are reused (about 20 uses each) and as
   * low as ~270 requests/s when every request carries its own delegation.
   * Default 100,000.
   */
  maxEntries?: number;
  /** Unix milliseconds; test seam. */
  now?: () => number;
}

interface Entry {
  value: number;
  expiresAtSeconds: number;
}

/**
 * In-process LRU replay store (spec §5.2 rule 6 default). Single instance only.
 *
 * Every operation is synchronous inside (the promises are only the interface
 * shape), so a check and the write that follows it can never interleave with
 * another caller. Do not add an `await` between a check and its write.
 */
export class MemoryReplayStore implements ReplayStore {
  private readonly entries = new Map<string, Entry>();
  private readonly maxEntries: number;
  private readonly now: () => number;

  constructor(options: MemoryReplayStoreOptions = {}) {
    const maxEntries = options.maxEntries ?? 100_000;
    if (!Number.isInteger(maxEntries) || maxEntries < 2) {
      throw new CraftedAIError('config_invalid', 'maxEntries must be an integer >= 2');
    }
    this.maxEntries = maxEntries;
    this.now = options.now ?? Date.now;
  }

  has(key: string): Promise<boolean> {
    return Promise.resolve(this.live(key) !== undefined);
  }

  markOnce(key: string, expiresAtSeconds: number): Promise<boolean> {
    if (this.live(key) !== undefined) return Promise.resolve(false);
    this.put(key, { value: 1, expiresAtSeconds });
    return Promise.resolve(true);
  }

  count(key: string): Promise<number> {
    return Promise.resolve(this.live(key)?.value ?? 0);
  }

  increment(key: string, expiresAtSeconds: number): Promise<number> {
    const entry = this.live(key);
    const next = {
      value: (entry?.value ?? 0) + 1,
      expiresAtSeconds: entry?.expiresAtSeconds ?? expiresAtSeconds,
    };
    this.put(key, next);
    return Promise.resolve(next.value);
  }

  recordRequest(input: RecordRequestInput): Promise<RecordRequestOutcome> {
    const { jtiKey, jtiExpiresAtSeconds, delegation } = input;
    if (this.live(jtiKey) !== undefined) return Promise.resolve('replayed');
    const uses = delegation === undefined ? undefined : this.live(delegation.key);
    if (delegation !== undefined && (uses?.value ?? 0) >= delegation.limit) {
      return Promise.resolve('delegation_exhausted');
    }
    this.put(jtiKey, { value: 1, expiresAtSeconds: jtiExpiresAtSeconds });
    if (delegation !== undefined) {
      this.put(delegation.key, {
        value: (uses?.value ?? 0) + 1,
        expiresAtSeconds: uses?.expiresAtSeconds ?? delegation.expiresAtSeconds,
      });
    }
    return Promise.resolve('recorded');
  }

  /** Live entries currently held (test and metrics seam). */
  get size(): number {
    return this.entries.size;
  }

  private live(key: string): Entry | undefined {
    const entry = this.entries.get(key);
    if (entry === undefined) return undefined;
    if (entry.expiresAtSeconds * 1000 <= this.now()) {
      this.entries.delete(key);
      return undefined;
    }
    return entry;
  }

  private put(key: string, entry: Entry): void {
    this.entries.delete(key);
    if (this.entries.size >= this.maxEntries) this.evict();
    this.entries.set(key, entry);
  }

  private evict(): void {
    const nowMs = this.now();
    for (const [key, entry] of this.entries) {
      if (entry.expiresAtSeconds * 1000 <= nowMs) this.entries.delete(key);
    }
    while (this.entries.size >= this.maxEntries) {
      const oldest = this.entries.keys().next();
      if (oldest.done === true) return;
      this.entries.delete(oldest.value);
    }
  }
}
