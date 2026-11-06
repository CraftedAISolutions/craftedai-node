import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { RequestVerificationReason } from '../../src/contract.js';
import { JwksCache } from '../../src/jwks-cache.js';
import { MemoryReplayStore } from '../../src/replay/memory-replay-store.js';
import type { RawRequest, VerifierDeps } from '../../src/verify.js';

/** Shape of core-api `test/vectors/request-token.json` (copied verbatim, CRA-350). */
export interface VectorCase {
  name: string;
  description: string;
  now: number;
  request: { method: string; headers: Record<string, string>; body: string | null };
  state?: { seenRequestJtis?: string[]; delegationUses?: Record<string, number> };
  expected:
    | { ok: true; orgId: string; user: string | null; delegated: boolean }
    | { ok: false; reason: RequestVerificationReason };
}
export interface VectorFile {
  WARNING: string;
  version: 1;
  config: {
    issuer: string;
    orgId: string;
    integrationId: string;
    publicUrl: string;
    appSecret: string;
    requireDelegation: boolean;
    delegationCallLimit: number;
  };
  jwks: { keys: Record<string, unknown>[] };
  testOnlyPrivateKeys: Record<'current' | 'next' | 'notInJwks', Record<string, string>>;
  cases: VectorCase[];
}

export const VECTOR_FILE_PATH = fileURLToPath(
  new URL('../vectors/request-token.json', import.meta.url),
);
export const vectors = JSON.parse(readFileSync(VECTOR_FILE_PATH, 'utf8')) as VectorFile;

/**
 * A verifier wired to the vector config, the vector JWKS (served by a fetch stub) and seeded
 * state. The vectors are signed with published test keys, so the cache must be told to trust
 * them (`allowTestVectorKeys`); production code never does.
 */
export async function vectorDeps(vector: VectorCase): Promise<VerifierDeps> {
  const nowMs = vector.now * 1000;
  const replay = new MemoryReplayStore({ now: () => nowMs });
  const exp = vector.now + 3600;
  for (const jti of vector.state?.seenRequestJtis ?? []) await replay.markOnce(`req:${jti}`, exp);
  for (const [jti, uses] of Object.entries(vector.state?.delegationUses ?? {})) {
    for (let i = 0; i < uses; i += 1) await replay.increment(`del:${jti}`, exp);
  }
  const { config } = vectors;
  return {
    apiOrigin: config.issuer,
    orgId: config.orgId,
    appSecret: config.appSecret,
    requireDelegation: config.requireDelegation,
    delegationCallLimit: config.delegationCallLimit,
    publicUrl: undefined,
    jwks: new JwksCache({
      apiOrigin: config.issuer,
      fetch: () => Promise.resolve(new Response(JSON.stringify(vectors.jwks))),
      now: () => nowMs,
      allowTestVectorKeys: true,
    }),
    replay,
    now: () => nowMs,
  };
}

/** The vector request as reached at the vector's publicUrl. */
export function vectorRequest(vector: VectorCase): RawRequest {
  const headers = new Headers(vector.request.headers);
  return {
    method: vector.request.method,
    url: vectors.config.publicUrl,
    header: (name) => headers.get(name) ?? undefined,
    body: vector.request.body === null ? null : new TextEncoder().encode(vector.request.body),
  };
}
