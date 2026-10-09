import { describe, expect, it, vi } from 'vitest';
import { delegationFor, NOW, signRequest, VECTOR_CONFIG } from '../test/helpers/sign.js';
import { vectors } from '../test/helpers/vectors.js';
import { CraftedAIError } from './errors.js';
import { JwksCache } from './jwks-cache.js';
import { MemoryReplayStore } from './replay/memory-replay-store.js';
import type { RecordRequestInput, ReplayStore } from './replay/replay-store.js';
import { failureBody, verifyRawRequest, type RawRequest, type VerifierDeps } from './verify.js';

const CALL_BODY =
  '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"get_order","arguments":{}}}';
const decodeJti = (token: string): string =>
  (JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString()) as { jti: string }).jti;

/** The primitive operations of a store, bound to it (spread, then override one). */
const bind = (store: MemoryReplayStore): Omit<ReplayStore, 'recordRequest'> => ({
  has: (k) => store.has(k),
  markOnce: (k, e) => store.markOnce(k, e),
  count: (k) => store.count(k),
  increment: (k, e) => store.increment(k, e),
});

const ACT = { externalUserId: 'member-1', channel: 'api', conversationId: 'conv-1' } as const;

function harness(overrides: Partial<VerifierDeps> = {}, jwksKeys = vectors.jwks.keys) {
  let nowMs = NOW * 1000;
  let keys = jwksKeys;
  const fetchMock = vi.fn(() => Promise.resolve(new Response(JSON.stringify({ keys }))));
  const deps: VerifierDeps = {
    apiOrigin: VECTOR_CONFIG.issuer,
    orgId: VECTOR_CONFIG.orgId,
    appSecret: VECTOR_CONFIG.appSecret,
    requireDelegation: true,
    delegationCallLimit: 20,
    publicUrl: undefined,
    jwks: new JwksCache({
      apiOrigin: VECTOR_CONFIG.issuer,
      fetch: fetchMock,
      now: () => nowMs,
      allowTestVectorKeys: true,
    }),
    replay: new MemoryReplayStore({ now: () => nowMs }),
    now: () => nowMs,
    ...overrides,
  };
  return {
    deps,
    fetchMock,
    publish: (next: typeof keys) => (keys = next),
    advance: (s: number) => (nowMs += s * 1000),
  };
}

function req(
  token: string | undefined,
  body: string | null,
  extra: Record<string, string> = {},
  url = VECTOR_CONFIG.publicUrl,
): RawRequest {
  const headers = new Headers(extra);
  if (token !== undefined) headers.set('x-craftedai-request', token);
  return {
    method: 'POST',
    url,
    header: (n) => headers.get(n) ?? undefined,
    body: body === null ? null : new TextEncoder().encode(body),
  };
}

describe('verifyRawRequest — sequences the vectors cannot express', () => {
  it('rejects a replay of an accepted request through the real store', async () => {
    const { deps } = harness();
    const token = await signRequest({ body: CALL_BODY });
    expect((await verifyRawRequest(req(token, CALL_BODY), deps)).ok).toBe(true);
    expect(await verifyRawRequest(req(token, CALL_BODY), deps)).toEqual({
      ok: false,
      reason: 'replayed',
    });
  });

  it('never burns a jti on a rejected request', async () => {
    const { deps } = harness();
    const token = await signRequest({ body: CALL_BODY });
    expect((await verifyRawRequest(req(token, `${CALL_BODY} `), deps)).ok).toBe(false);
    expect((await verifyRawRequest(req(token, CALL_BODY), deps)).ok).toBe(true);
  });

  it('reports replayed before body_mismatch (frozen check order)', async () => {
    const { deps } = harness();
    const token = await signRequest({ body: CALL_BODY });
    expect((await verifyRawRequest(req(token, CALL_BODY), deps)).ok).toBe(true);
    expect(await verifyRawRequest(req(token, `${CALL_BODY} `), deps)).toEqual({
      ok: false,
      reason: 'replayed',
    });
  });

  it('an exhausted delegation does not burn the request jti', async () => {
    const { deps } = harness({ delegationCallLimit: 1 });
    const spent = await delegationFor('member-1');
    const first = await signRequest({ body: CALL_BODY, act: ACT });
    await verifyRawRequest(req(first, CALL_BODY, { 'x-craftedai-actor-delegation': spent }), deps);
    const token = await signRequest({ body: CALL_BODY, act: ACT });
    expect(
      await verifyRawRequest(
        req(token, CALL_BODY, { 'x-craftedai-actor-delegation': spent }),
        deps,
      ),
    ).toEqual({ ok: false, reason: 'delegation_exhausted' });
    const fresh = await delegationFor('member-1');
    expect(
      (
        await verifyRawRequest(
          req(token, CALL_BODY, { 'x-craftedai-actor-delegation': fresh }),
          deps,
        )
      ).ok,
    ).toBe(true);
  });

  it('another instance spending the last use after our read: recordRequest decides', async () => {
    const memory = new MemoryReplayStore({ now: () => NOW * 1000 });
    // Every read happened before the other instance's write: it still says "free".
    const staleReads: ReplayStore = {
      has: () => Promise.resolve(false),
      markOnce: (k, e) => memory.markOnce(k, e),
      count: () => Promise.resolve(0),
      increment: (k, e) => memory.increment(k, e),
      recordRequest: (input) => memory.recordRequest(input),
    };
    const { deps } = harness({ delegationCallLimit: 1, replay: staleReads });
    const delegationJti = 'd-race';
    await memory.increment(`del:${delegationJti}`, NOW + 300);
    const token = await signRequest({ body: CALL_BODY, act: ACT });
    const delegated = {
      'x-craftedai-actor-delegation': await delegationFor('member-1', delegationJti),
    };
    expect(await verifyRawRequest(req(token, CALL_BODY, delegated), deps)).toEqual({
      ok: false,
      reason: 'delegation_exhausted',
    });
    // The refused request burned nothing: its jti is free for a fresh delegation.
    expect(await memory.has(`req:${decodeJti(token)}`)).toBe(false);
  });

  it('another instance recording the same jti after our read: recordRequest decides', async () => {
    const memory = new MemoryReplayStore({ now: () => NOW * 1000 });
    const staleReads: ReplayStore = {
      has: () => Promise.resolve(false),
      markOnce: (k, e) => memory.markOnce(k, e),
      count: () => Promise.resolve(0),
      increment: (k, e) => memory.increment(k, e),
      recordRequest: (input) => memory.recordRequest(input),
    };
    const { deps } = harness({ replay: staleReads });
    const token = await signRequest({ body: CALL_BODY });
    await memory.markOnce(`req:${decodeJti(token)}`, NOW + 60);
    expect(await verifyRawRequest(req(token, CALL_BODY), deps)).toEqual({
      ok: false,
      reason: 'replayed',
    });
  });

  it('commits through one recordRequest call and never composes markOnce / increment', async () => {
    const memory = new MemoryReplayStore({ now: () => NOW * 1000 });
    const recordRequest = vi.fn((input: RecordRequestInput) => memory.recordRequest(input));
    const forbidden = () => Promise.reject(new Error('the verifier must not compose primitives'));
    const store: ReplayStore = {
      has: (k) => memory.has(k),
      markOnce: forbidden,
      count: forbidden,
      increment: forbidden,
      recordRequest,
    };
    const { deps } = harness({ replay: store });
    const delegationJti = 'd-atomic';
    const token = await signRequest({ body: CALL_BODY, act: ACT });
    const result = await verifyRawRequest(
      req(token, CALL_BODY, {
        'x-craftedai-actor-delegation': await delegationFor('member-1', delegationJti),
      }),
      deps,
    );
    expect(result.ok).toBe(true);
    expect(recordRequest).toHaveBeenCalledTimes(1);
    expect(recordRequest).toHaveBeenCalledWith({
      jtiKey: `req:${decodeJti(token)}`,
      jtiExpiresAtSeconds: NOW + 60,
      delegation: { key: `del:${delegationJti}`, limit: 20, expiresAtSeconds: NOW + 300 },
    });
  });

  it('omits the delegation from the commit when the call carries no act', async () => {
    const memory = new MemoryReplayStore({ now: () => NOW * 1000 });
    const recordRequest = vi.fn((input: RecordRequestInput) => memory.recordRequest(input));
    const { deps } = harness({ replay: { ...bind(memory), recordRequest } });
    const token = await signRequest({ body: CALL_BODY });
    expect((await verifyRawRequest(req(token, CALL_BODY), deps)).ok).toBe(true);
    expect(recordRequest).toHaveBeenCalledWith({
      jtiKey: `req:${decodeJti(token)}`,
      jtiExpiresAtSeconds: NOW + 60,
    });
  });

  it('writes nothing for a rejected request (recordRequest is last)', async () => {
    const memory = new MemoryReplayStore({ now: () => NOW * 1000 });
    const recordRequest = vi.fn((input: RecordRequestInput) => memory.recordRequest(input));
    const { deps } = harness({ replay: { ...bind(memory), recordRequest } });
    const token = await signRequest({ body: CALL_BODY, act: ACT });
    // body mismatch, then a missing delegation: both fail before the commit.
    await verifyRawRequest(req(token, `${CALL_BODY} `), deps);
    await verifyRawRequest(req(token, CALL_BODY), deps);
    expect(recordRequest).not.toHaveBeenCalled();
    expect(memory.size).toBe(0);
  });

  it('a request jti equal to a delegation jti does not interfere (separate namespaces)', async () => {
    const { deps } = harness({ delegationCallLimit: 1 });
    const shared = 'same-id-everywhere';
    const send = async (requestJti: string, delegationJti: string) =>
      verifyRawRequest(
        req(await signRequest({ body: CALL_BODY, act: ACT, jti: requestJti }), CALL_BODY, {
          'x-craftedai-actor-delegation': await delegationFor('member-1', delegationJti),
        }),
        deps,
      );
    // Spending a delegation whose jti is `shared` must not make a request jti `shared` a replay...
    expect((await send('request-1', shared)).ok).toBe(true);
    expect((await send(shared, 'delegation-2')).ok).toBe(true);
    // ...and the request jti `shared` just recorded must not count as a use of delegation `shared`
    // (limit 1: that delegation is spent, so it is exhausted only because of its own use).
    expect(await send('request-3', shared)).toEqual({ ok: false, reason: 'delegation_exhausted' });
    expect(await send(shared, 'delegation-4')).toEqual({ ok: false, reason: 'replayed' });
    // A delegation whose jti equals an already-recorded request jti is still fresh.
    expect((await send('request-5', 'request-1')).ok).toBe(true);
  });

  it('accepts a channel it has never heard of (act.channel is an open string)', async () => {
    const { deps } = harness();
    const act = { externalUserId: 'member-1', channel: 'whatsapp', conversationId: 'c-9' };
    const result = await verifyRawRequest(
      req(await signRequest({ body: CALL_BODY, act }), CALL_BODY, {
        'x-craftedai-actor-delegation': await delegationFor('member-1'),
      }),
      deps,
    );
    expect(result).toMatchObject({ ok: true, context: { act } });
  });

  it('allows 20 tools/calls per delegation token and refuses the 21st', async () => {
    const { deps } = harness();
    const delegation = await delegationFor('member-1');
    for (let i = 0; i < 20; i += 1) {
      const token = await signRequest({ body: CALL_BODY, act: ACT });
      const result = await verifyRawRequest(
        req(token, CALL_BODY, { 'x-craftedai-actor-delegation': delegation }),
        deps,
      );
      expect(result.ok).toBe(true);
    }
    const token = await signRequest({ body: CALL_BODY, act: ACT });
    expect(
      await verifyRawRequest(
        req(token, CALL_BODY, { 'x-craftedai-actor-delegation': delegation }),
        deps,
      ),
    ).toEqual({ ok: false, reason: 'delegation_exhausted' });
  });

  it('honours a custom delegation call limit', async () => {
    const { deps } = harness({ delegationCallLimit: 1 });
    const delegation = await delegationFor('member-1');
    const send = async () =>
      verifyRawRequest(
        req(await signRequest({ body: CALL_BODY, act: ACT }), CALL_BODY, {
          'x-craftedai-actor-delegation': delegation,
        }),
        deps,
      );
    expect((await send()).ok).toBe(true);
    expect(await send()).toEqual({ ok: false, reason: 'delegation_exhausted' });
  });

  it('returns the request context', async () => {
    const { deps } = harness();
    const result = await verifyRawRequest(
      req(await signRequest({ body: CALL_BODY, act: ACT }), CALL_BODY, {
        'x-craftedai-actor-delegation': await delegationFor('member-1'),
      }),
      deps,
    );
    expect(result).toEqual({
      ok: true,
      context: {
        orgId: VECTOR_CONFIG.orgId,
        integrationId: VECTOR_CONFIG.integrationId,
        user: 'member-1',
        delegated: true,
        act: ACT,
      },
    });
  });

  it('requireDelegation: false lets an end-user call through undelegated', async () => {
    const { deps } = harness({ requireDelegation: false });
    const result = await verifyRawRequest(
      req(await signRequest({ body: CALL_BODY, act: ACT }), CALL_BODY),
      deps,
    );
    expect(result.ok && result.context).toMatchObject({ user: 'member-1', delegated: false });
  });
});

describe('verifyRawRequest — unknown kid and key rotation (rule 1)', () => {
  it.each(['bad_signature_alg_none', 'bad_signature_hs256_key_confusion'])(
    '%s is refused before any key lookup (no JWKS fetch)',
    async (name) => {
      const vector = vectors.cases.find((c) => c.name === name)!;
      const { deps, fetchMock } = harness();
      const token = vector.request.headers['x-craftedai-request']!;
      expect(await verifyRawRequest(req(token, vector.request.body), deps)).toEqual({
        ok: false,
        reason: 'bad_signature',
      });
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it.each(['bad_signature_kid_missing', 'bad_signature_kid_empty', 'bad_signature_kid_oversized'])(
    '%s is bad_signature, not unknown_key, and never reaches the JWKS',
    async (name) => {
      const vector = vectors.cases.find((c) => c.name === name)!;
      const { deps, fetchMock } = harness();
      const token = vector.request.headers['x-craftedai-request']!;
      expect(await verifyRawRequest(req(token, vector.request.body), deps)).toEqual({
        ok: false,
        reason: 'bad_signature',
      });
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it('a well-formed kid that is not in the JWKS is unknown_key', async () => {
    const { deps } = harness();
    const token = await signRequest({ body: null, key: 'notInJwks' });
    expect(await verifyRawRequest(req(token, null), deps)).toEqual({
      ok: false,
      reason: 'unknown_key',
    });
  });

  it('accepts a key published after the first fetch once 30 s have passed, without refetching per request', async () => {
    const [current] = vectors.jwks.keys;
    const { deps, fetchMock, publish, advance } = harness({}, [current!]);
    expect((await verifyRawRequest(req(await signRequest({ body: null }), null), deps)).ok).toBe(
      true,
    );
    publish(vectors.jwks.keys);
    const nextSigned = await signRequest({ body: null, key: 'next' });
    expect(await verifyRawRequest(req(nextSigned, null), deps)).toEqual({
      ok: false,
      reason: 'unknown_key',
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    advance(30);
    const again = await signRequest({ body: null, key: 'next', iat: NOW + 30 });
    expect((await verifyRawRequest(req(again, null), deps)).ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('says where it could not fetch the keys from', async () => {
    const result = await verifyRawRequest(req(await signRequest({ body: null }), null), {
      ...harness().deps,
      jwks: new JwksCache({
        apiOrigin: VECTOR_CONFIG.issuer,
        fetch: () => Promise.reject(new Error('down')),
        now: () => NOW * 1000,
        allowTestVectorKeys: true,
      }),
    });
    expect(result).toEqual({
      ok: false,
      reason: 'unknown_key',
      message: `could not fetch the CraftedAI signing keys from ${VECTOR_CONFIG.issuer}/.well-known/jwks.json`,
    });
  });
});

describe('spec §12.1 — MCP behind a proxy', () => {
  const internal = 'http://10.0.0.12:8080/mcp';

  it('names the expected and the seen URL on wrong_audience', async () => {
    const { deps } = harness();
    const result = await verifyRawRequest(
      req(await signRequest({ body: null }), null, {}, internal),
      deps,
    );
    expect(result).toMatchObject({ ok: false, reason: 'wrong_audience' });
    expect(!result.ok && result.message).toContain(VECTOR_CONFIG.publicUrl);
    expect(!result.ok && result.message).toContain(internal);
    expect(!result.ok && result.message).toContain('publicUrl');
  });

  it('publicUrl fixes it', async () => {
    const { deps } = harness({ publicUrl: [VECTOR_CONFIG.publicUrl] });
    const result = await verifyRawRequest(
      req(await signRequest({ body: null }), null, {}, internal),
      deps,
    );
    expect(result.ok).toBe(true);
  });
});

describe('spec §12.2 — clock skew', () => {
  it.each([
    ['clock 60 s behind: tolerated', -60, true],
    ['clock 59 s ahead: tolerated (token still valid)', 59, true],
  ])('%s', async (_label, offset, ok) => {
    const { deps, advance } = harness();
    const token = await signRequest({ body: null });
    advance(offset);
    expect((await verifyRawRequest(req(token, null), deps)).ok).toBe(ok);
  });

  it('clock 61 s behind: expired, with a clock hint', async () => {
    const { deps, advance } = harness();
    const token = await signRequest({ body: null });
    advance(-61);
    const result = await verifyRawRequest(req(token, null), deps);
    expect(result).toMatchObject({ ok: false, reason: 'expired' });
    expect(!result.ok && result.message).toMatch(/clock is behind.*NTP/);
  });

  it('clock 60 s ahead: expired, with a clock hint', async () => {
    const { deps, advance } = harness();
    const token = await signRequest({ body: null });
    advance(60);
    const result = await verifyRawRequest(req(token, null), deps);
    expect(result).toMatchObject({ ok: false, reason: 'expired' });
    expect(!result.ok && result.message).toMatch(/clock is ahead/);
  });
});

describe('spec §12.3 — body re-serialized before the guard', () => {
  it('says body_mismatch and names the body parser', async () => {
    const { deps } = harness();
    const token = await signRequest({ body: CALL_BODY });
    const reserialized = JSON.stringify(JSON.parse(CALL_BODY), null, 1);
    const result = await verifyRawRequest(req(token, reserialized), deps);
    expect(result).toMatchObject({ ok: false, reason: 'body_mismatch' });
    expect(!result.ok && result.message).toContain('express.json()');
  });
});

describe('configuration', () => {
  it('refuses a delegated call when the MCP has no app secret', async () => {
    const { deps } = harness({ appSecret: undefined });
    const result = await verifyRawRequest(
      req(await signRequest({ body: CALL_BODY, act: ACT }), CALL_BODY, {
        'x-craftedai-actor-delegation': await delegationFor('member-1'),
      }),
      deps,
    );
    expect(result).toMatchObject({ ok: false, reason: 'delegation_invalid' });
  });
});

describe('app secret rotation (CRAFTEDAI_APP_SECRET_PREVIOUS)', () => {
  const NEW_SECRET = 'TkVXLWFwcC1zZWNyZXQtYWZ0ZXItcm90YXRpb24tNDMtY2hhcnM';

  // `delegationFor` signs with VECTOR_CONFIG.appSecret: here that is the secret being retired.
  const delegatedCall = async (deps: VerifierDeps) =>
    verifyRawRequest(
      req(await signRequest({ body: CALL_BODY, act: ACT }), CALL_BODY, {
        'x-craftedai-actor-delegation': await delegationFor('member-1'),
      }),
      deps,
    );

  it('accepts a delegation signed with the previous secret during the overlap', async () => {
    const { deps } = harness({
      appSecret: NEW_SECRET,
      previousAppSecret: VECTOR_CONFIG.appSecret,
    });
    expect(await delegatedCall(deps)).toMatchObject({ ok: true });
  });

  it('refuses it as delegation_invalid once the previous secret is removed', async () => {
    const { deps } = harness({ appSecret: NEW_SECRET });
    expect(await delegatedCall(deps)).toEqual({ ok: false, reason: 'delegation_invalid' });
  });

  it('keeps counting calls per delegation jti whichever secret signed it', async () => {
    const { deps } = harness({
      appSecret: NEW_SECRET,
      previousAppSecret: VECTOR_CONFIG.appSecret,
      delegationCallLimit: 1,
    });
    const delegation = await delegationFor('member-1');
    const send = async () =>
      verifyRawRequest(
        req(await signRequest({ body: CALL_BODY, act: ACT }), CALL_BODY, {
          'x-craftedai-actor-delegation': delegation,
        }),
        deps,
      );
    expect((await send()).ok).toBe(true);
    expect(await send()).toEqual({ ok: false, reason: 'delegation_exhausted' });
  });
});

describe('fail closed on a misbehaving or failing replay store', () => {
  const storeWith = (overrides: Partial<ReplayStore>): ReplayStore => ({
    ...bind(new MemoryReplayStore({ now: () => NOW * 1000 })),
    recordRequest: () => Promise.resolve('recorded'),
    ...overrides,
  });

  it.each([
    ['undefined', undefined],
    ['true', true],
    ['a misspelt string', 'Recorded'],
  ])('a store answering %s never lets the request through', async (_label, answer) => {
    const { deps } = harness({
      replay: storeWith({ recordRequest: () => Promise.resolve(answer as never) }),
    });
    const token = await signRequest({ body: CALL_BODY });
    const outcome = await verifyRawRequest(req(token, CALL_BODY), deps).then(
      (result) => result,
      (error: unknown) => error,
    );
    expect(outcome).toBeInstanceOf(CraftedAIError);
    expect(outcome).toMatchObject({ code: 'config_invalid' });
  });

  it('rejects when recordRequest rejects, never resolving ok', async () => {
    const { deps } = harness({
      replay: storeWith({ recordRequest: () => Promise.reject(new Error('redis down')) }),
    });
    const token = await signRequest({ body: CALL_BODY });
    await expect(verifyRawRequest(req(token, CALL_BODY), deps)).rejects.toThrow('redis down');
  });

  it('rejects when has rejects, never resolving ok', async () => {
    const { deps } = harness({
      replay: storeWith({ has: () => Promise.reject(new Error('redis down')) }),
    });
    const token = await signRequest({ body: CALL_BODY });
    await expect(verifyRawRequest(req(token, CALL_BODY), deps)).rejects.toThrow('redis down');
  });
});

describe('failureBody', () => {
  it('caps the message at 500 characters', () => {
    const body = failureBody({ ok: false, reason: 'expired', message: 'x'.repeat(501) });
    expect(body.message).toBe('x'.repeat(500));
  });

  it('keeps a message of exactly 500 characters whole', () => {
    const message = 'y'.repeat(500);
    expect(failureBody({ ok: false, reason: 'expired', message }).message).toBe(message);
  });

  it('omits message when there is none', () => {
    const body = failureBody({ ok: false, reason: 'replayed' });
    expect(body).toEqual({ error: 'craftedai_verification_failed', reason: 'replayed' });
    expect('message' in body).toBe(false);
  });
});
