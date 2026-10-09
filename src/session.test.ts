import { decodeJwt } from 'jose';
import { describe, expect, it, vi } from 'vitest';
import {
  AGENT_ID,
  APP_SECRET,
  coreApiStub,
  jsonResponse,
  MINT_RESPONSE,
  NOW_MS,
  ORG_ID,
  SECRET_KEY,
} from '../test/helpers/core-api-stub.js';
import { vectors } from '../test/helpers/vectors.js';
import { verifyDelegationToken } from './delegation.js';
import { CraftedAIError } from './errors.js';
import {
  createSession,
  handleSessionRoute,
  revokeSessions,
  type CreateSessionInput,
  type EmbedSessionBoot,
  type SessionRouteInput,
} from './session.js';

const INPUT = { externalUserId: 'member-1', agentId: AGENT_ID, hostOrigin: 'https://shop.example' };

function deps(answer: Parameters<typeof coreApiStub>[0]) {
  const stub = coreApiStub(answer);
  return {
    stub,
    deps: {
      apiOrigin: 'https://api.craftedai.test',
      secretKey: SECRET_KEY,
      appSecret: APP_SECRET,
      orgId: ORG_ID,
      fetch: stub.fetch,
      now: () => NOW_MS,
    },
  };
}

describe('createSession (spec §5.5)', () => {
  it('POSTs the mint with the key, the user header and a fresh 300 s delegation', async () => {
    const { stub, deps: d } = deps(() => jsonResponse(201, MINT_RESPONSE));
    const boot = await createSession(INPUT, d);

    const [call] = stub.calls;
    expect(call?.url).toBe('https://api.craftedai.test/portal/v1/embed-sessions');
    expect(call?.init.method).toBe('POST');
    expect(call?.init.redirect).toBe('error');
    const headers = new Headers(call?.init.headers);
    expect(headers.get('authorization')).toBe(`Bearer ${SECRET_KEY}`);
    expect(headers.get('x-external-user-id')).toBe('member-1');
    const body = JSON.parse(String(call?.init.body)) as {
      agentId: string;
      hostOrigin: string;
      ttlSeconds: number;
      delegation: { token: string; expiresAt: string };
    };
    expect(body).toMatchObject({
      agentId: AGENT_ID,
      hostOrigin: 'https://shop.example',
      ttlSeconds: 900,
    });
    const claims = await verifyDelegationToken(body.delegation.token, {
      appSecret: APP_SECRET,
      orgId: ORG_ID,
      nowSeconds: NOW_MS / 1000,
    });
    expect(claims).toMatchObject({ sub: 'member-1', org: ORG_ID, exp: NOW_MS / 1000 + 300 });
    expect(body.delegation.expiresAt).toBe(new Date(NOW_MS + 300_000).toISOString());

    expect(boot).toEqual({
      token: MINT_RESPONSE.embedSession.token,
      expiresAt: MINT_RESPONSE.embedSession.expiresAt,
      refreshBeforeSeconds: 60,
      frameUrl: MINT_RESPONSE.embedSession.frameUrl,
      frameOrigin: MINT_RESPONSE.embedSession.frameOrigin,
      branding: MINT_RESPONSE.branding,
    });
    expect(JSON.stringify(boot)).not.toContain(SECRET_KEY);
    expect(JSON.stringify(boot)).not.toContain(body.delegation.token);
  });

  it('mints a new delegation jti every time', async () => {
    const { stub, deps: d } = deps(() => jsonResponse(201, MINT_RESPONSE));
    await createSession(INPUT, d);
    await createSession(INPUT, d);
    const jtis = stub.calls.map((c) => {
      const body = JSON.parse(String(c.init.body)) as { delegation: { token: string } };
      return decodeJwt(body.delegation.token).jti;
    });
    expect(new Set(jtis).size).toBe(2);
  });

  it.each([
    [401, { error: 'invalid_credentials' }, 'invalid_credentials'],
    [403, { error: 'agent_not_allowed_for_key' }, 'agent_not_allowed_for_key'],
    [403, { error: 'embed_origin_not_allowed' }, 'embed_origin_not_allowed'],
    [404, { error: 'agent_unavailable' }, 'agent_unavailable'],
    [400, { error: 'invalid_request' }, 'invalid_request'],
    [503, { error: 'service_unavailable' }, 'api_unavailable'],
  ])('maps core-api %i %j to %s', async (status, body, code) => {
    const { deps: d } = deps(() => jsonResponse(status, body));
    const error = await createSession(INPUT, d).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CraftedAIError);
    expect((error as CraftedAIError).code).toBe(code);
    expect((error as CraftedAIError).message).not.toContain(SECRET_KEY);
  });

  it('refuses an external user id with a space before calling core-api', async () => {
    const { stub, deps: d } = deps(() => jsonResponse(201, MINT_RESPONSE));
    await expect(createSession({ ...INPUT, externalUserId: 'a b' }, d)).rejects.toMatchObject({
      code: 'invalid_argument',
    });
    expect(stub.calls).toHaveLength(0);
  });

  it('treats an unexpected 201 body as api_unavailable', async () => {
    const { deps: d } = deps(() =>
      jsonResponse(201, { embedSession: { token: 'cai_x' }, branding: {} }),
    );
    await expect(createSession(INPUT, d)).rejects.toMatchObject({ code: 'api_unavailable' });
  });
});

describe('revokeSessions', () => {
  it('DELETEs the user session and resolves on 204', async () => {
    const { stub, deps: d } = deps(() => new Response(null, { status: 204 }));
    await revokeSessions('member-1', d);
    expect(stub.calls[0]?.init.method).toBe('DELETE');
    expect(new Headers(stub.calls[0]?.init.headers).get('x-external-user-id')).toBe('member-1');
  });

  it('throws invalid_credentials on 401', async () => {
    const { deps: d } = deps(() => jsonResponse(401, { error: 'invalid_credentials' }));
    await expect(revokeSessions('member-1', d)).rejects.toMatchObject({
      code: 'invalid_credentials',
    });
  });
});

describe('handleSessionRoute (the widget contract)', () => {
  const OK: SessionRouteInput = {
    user: 'member-1',
    contentType: 'application/json',
    origin: 'https://shop.example',
    body: { agentId: AGENT_ID },
  };
  const BOOT = { token: 't' } as unknown as EmbedSessionBoot;
  const route = (
    input: Partial<SessionRouteInput>,
    mint: (i: CreateSessionInput) => Promise<EmbedSessionBoot> = () => Promise.resolve(BOOT),
    agentIds?: string[],
  ) =>
    handleSessionRoute(
      { ...OK, ...input },
      { agentIds, ttlSeconds: undefined },
      mint,
      () => undefined,
    );

  it.each([
    ['signed out', { user: null }, 401],
    ['form post (no JSON)', { contentType: 'application/x-www-form-urlencoded' }, 415],
    ['no agentId', { body: {} }, 400],
    ['no Origin', { origin: undefined }, 400],
  ] as [string, Partial<SessionRouteInput>, number][])('%s → %s', async (_label, input, status) => {
    expect((await route(input)).status).toBe(status);
  });

  it('restricts agents when agentIds is set', async () => {
    expect((await route({}, undefined, ['other'])).status).toBe(403);
  });

  it('passes the user, agent and Origin to the mint', async () => {
    let seen: CreateSessionInput | undefined;
    await route({}, (input) => {
      seen = input;
      return Promise.resolve(BOOT);
    });
    expect(seen).toEqual({
      externalUserId: 'member-1',
      agentId: AGENT_ID,
      hostOrigin: 'https://shop.example',
    });
  });

  it.each([
    ['agent_unavailable', 404],
    ['agent_not_allowed_for_key', 403],
    ['embed_origin_not_allowed', 403],
    ['invalid_credentials', 502],
    ['api_unavailable', 502],
  ] as const)('maps %s to %i', async (code, status) => {
    const result = await route({}, () => Promise.reject(new CraftedAIError(code, 'x')));
    expect(result.status).toBe(status);
  });
});

describe('createSession validates before it mints or calls core-api (review corrections 1, 3)', () => {
  const refused = async (
    input: CreateSessionInput,
    override: Partial<ReturnType<typeof deps>['deps']>,
    code: string,
  ) => {
    const { stub, deps: d } = deps(() => jsonResponse(201, MINT_RESPONSE));
    const error = await createSession(input, { ...d, ...override }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CraftedAIError);
    expect((error as CraftedAIError).code).toBe(code);
    expect(stub.calls).toHaveLength(0);
    return error as CraftedAIError;
  };

  it.each(['', 'a b', 'tab\there', 'ünï', 'x'.repeat(257)])(
    'refuses external user id %j with invalid_argument',
    async (externalUserId) => {
      await refused({ ...INPUT, externalUserId }, {}, 'invalid_argument');
    },
  );

  it.each([59, 1801, 900.5, Number.NaN, Number.POSITIVE_INFINITY])(
    'refuses ttlSeconds %s with invalid_argument',
    async (ttlSeconds) => {
      await refused({ ...INPUT, ttlSeconds }, {}, 'invalid_argument');
    },
  );

  it.each([60, 1800])('accepts the ttlSeconds bound %i', async (ttlSeconds) => {
    const { stub, deps: d } = deps(() => jsonResponse(201, MINT_RESPONSE));
    await createSession({ ...INPUT, ttlSeconds }, d);
    expect(JSON.parse(String(stub.calls[0]?.init.body))).toMatchObject({ ttlSeconds });
  });

  it('refuses a malformed app secret with config_invalid, never echoing it', async () => {
    const error = await refused(INPUT, { appSecret: 'short-secret' }, 'config_invalid');
    expect(error.message).not.toContain('short-secret');
  });

  it('refuses the published test-vector app secret with config_invalid', async () => {
    const error = await refused(INPUT, { appSecret: vectors.config.appSecret }, 'config_invalid');
    expect(error.message).not.toContain(vectors.config.appSecret);
  });

  it('always signs the delegation for 300 s, whatever the embed session ttl', async () => {
    const { stub, deps: d } = deps(() => jsonResponse(201, MINT_RESPONSE));
    await createSession({ ...INPUT, ttlSeconds: 1800 }, d);
    const body = JSON.parse(String(stub.calls[0]?.init.body)) as { delegation: { token: string } };
    const claims = decodeJwt(body.delegation.token);
    expect((claims.exp ?? 0) - (claims.iat ?? 0)).toBe(300);
  });
});

describe('handleSessionRoute: request gating and onError (fix round 1)', () => {
  const OK: SessionRouteInput = {
    user: 'member-1',
    contentType: 'application/json',
    origin: 'https://shop.example',
    body: { agentId: AGENT_ID },
  };
  const BOOT = { token: 't' } as unknown as EmbedSessionBoot;

  function run(
    input: Partial<SessionRouteInput>,
    mint?: (i: CreateSessionInput) => Promise<EmbedSessionBoot>,
  ) {
    const minted = vi.fn(mint ?? (() => Promise.resolve(BOOT)));
    const onError = vi.fn();
    const result = handleSessionRoute(
      { ...OK, ...input },
      { agentIds: undefined, ttlSeconds: undefined },
      minted,
      onError,
    );
    return { result, minted, onError };
  }

  it('hands the thrown error to onError on the 502 path', async () => {
    const failure = new CraftedAIError('api_unavailable', 'core-api down');
    const { result, onError } = run({}, () => Promise.reject(failure));
    expect((await result).status).toBe(502);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(failure);
  });

  it('hands a non-CraftedAIError to onError too, and still answers 502', async () => {
    const failure = new TypeError('boom');
    const { result, onError } = run({}, () => Promise.reject(failure));
    expect((await result).status).toBe(502);
    expect(onError).toHaveBeenCalledWith(failure);
  });

  it.each([
    ['agent_unavailable', 404],
    ['agent_not_allowed_for_key', 403],
    ['embed_origin_not_allowed', 403],
    ['invalid_argument', 400],
  ] as const)('does not call onError for the expected outcome %s (%i)', async (code, status) => {
    const { result, onError } = run({}, () => Promise.reject(new CraftedAIError(code, 'x')));
    expect((await result).status).toBe(status);
    expect(onError).not.toHaveBeenCalled();
  });

  it.each(['invalid_credentials', 'api_unavailable', 'invalid_request'] as const)(
    'calls onError for the unexpected failure %s (502)',
    async (code) => {
      const failure = new CraftedAIError(code, 'x');
      const { result, onError } = run({}, () => Promise.reject(failure));
      expect((await result).status).toBe(502);
      expect(onError).toHaveBeenCalledExactlyOnceWith(failure);
    },
  );

  it('does not call onError when the request was fine', async () => {
    const { result, onError } = run({});
    expect((await result).status).toBe(200);
    expect(onError).not.toHaveBeenCalled();
  });

  it.each([
    ['text/plain', 415],
    ['multipart/form-data; boundary=x', 415],
    [undefined, 415],
    ['', 415],
    ['application/json', 200],
    ['application/json; charset=utf-8', 200],
    ['Application/JSON;charset=UTF-8', 200],
  ] as [string | undefined, number][])('content-type %j gives %i', async (contentType, status) => {
    const { result } = run({ contentType });
    expect((await result).status).toBe(status);
  });

  it.each([
    'null',
    '',
    'not an origin',
    'https://shop.example/',
    'https://shop.example/path',
    'file:///x',
  ])('Origin %j gives 400 and never mints', async (origin) => {
    const { result, minted, onError } = run({ origin });
    expect((await result).status).toBe(400);
    expect(minted).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
  });

  it.each(['http://localhost:3000', 'https://shop.example:8443'])(
    'accepts Origin %s',
    async (origin) => {
      const { result, minted } = run({ origin });
      expect((await result).status).toBe(200);
      expect(minted).toHaveBeenCalledTimes(1);
    },
  );

  it.each([
    ['not-a-uuid'],
    [''],
    ['44444444-4444-4444-8444-44444444444'],
    ['44444444-4444-4444-8444-4444444444444'],
    ['../../etc/passwd'],
    [42],
    [null],
  ])('agentId %j gives 400 and never mints', async (agentId) => {
    const { result, minted, onError } = run({ body: { agentId } });
    expect((await result).status).toBe(400);
    expect(minted).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
  });

  it('keeps the agentIds allow-list as a 403, after the shape check', async () => {
    const minted = vi.fn(() => Promise.resolve(BOOT));
    const route = (agentId: string) =>
      handleSessionRoute(
        { ...OK, body: { agentId } },
        { agentIds: ['55555555-5555-4555-8555-555555555555'], ttlSeconds: undefined },
        minted,
        () => undefined,
      );
    expect((await route(AGENT_ID)).status).toBe(403);
    expect((await route('nope')).status).toBe(400);
    expect(minted).not.toHaveBeenCalled();
  });
});
