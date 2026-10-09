import { describe, expect, it } from 'vitest';
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
import { printed } from '../test/helpers/printed.js';
import { createOwnSigner } from '../test/helpers/own-signer.js';
import { NOW as VECTOR_NOW, signRequest } from '../test/helpers/sign.js';
import { vectors } from '../test/helpers/vectors.js';
import { CraftedAI } from './craftedai.js';
import { verifyDelegationToken, mintDelegationToken } from './delegation.js';
import { CraftedAIError } from './errors.js';
import type { ReplayStore } from './replay/replay-store.js';

const ISSUER = 'https://api.craftedai.test';
const MCP_URL = 'https://mcp.shop.example/mcp';
const NOW_S = NOW_MS / 1000;
const BODY =
  '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"get_order","arguments":{}}}';

const WEB_ENV = {
  CRAFTEDAI_SECRET_KEY: SECRET_KEY,
  CRAFTEDAI_APP_SECRET: APP_SECRET,
  CRAFTEDAI_ORG_ID: ORG_ID,
};

/** Runs `construct` and returns the CraftedAIError it throws (fails the test if it does not). */
function constructionError(construct: () => unknown): CraftedAIError {
  try {
    construct();
  } catch (error) {
    expect(error).toBeInstanceOf(CraftedAIError);
    return error as CraftedAIError;
  }
  throw new Error('expected construction to throw');
}

describe('CraftedAI configuration', () => {
  it('reads the three env vars and defaults the origins (spec §4.3)', () => {
    const craftedai = new CraftedAI({ env: WEB_ENV });
    expect(craftedai.config).toMatchObject({
      secretKey: SECRET_KEY,
      appSecret: APP_SECRET,
      orgId: ORG_ID,
      apiOrigin: 'https://api.craftedai.co',
      chatOrigin: 'https://chat.craftedai.co',
      requireDelegation: true,
      delegationCallLimit: 20,
    });
  });

  it('constructs for an MCP-only service with no secret key; minting then says what is missing', async () => {
    const craftedai = new CraftedAI({
      env: { CRAFTEDAI_APP_SECRET: APP_SECRET, CRAFTEDAI_ORG_ID: ORG_ID },
    });
    await expect(
      craftedai.createSession({ externalUserId: 'u', agentId: 'a', hostOrigin: 'https://x.test' }),
    ).rejects.toMatchObject({
      code: 'config_missing',
      message: expect.stringContaining('CRAFTEDAI_SECRET_KEY') as unknown,
    });
  });

  it('refuses a short app secret at construction without echoing it', () => {
    const error = constructionError(
      () => new CraftedAI({ env: { ...WEB_ENV, CRAFTEDAI_APP_SECRET: 'short-secret' } }),
    );
    expect(error.code).toBe('config_invalid');
    expect(error.message).toContain('CRAFTEDAI_APP_SECRET');
    expect(error.message).not.toContain('short-secret');
  });

  it('reads CRAFTEDAI_PUBLIC_URL (comma-separated) and staging origins', () => {
    const craftedai = new CraftedAI({
      env: {
        CRAFTEDAI_PUBLIC_URL: 'https://mcp.shop.example/mcp, https://mcp2.shop.example/mcp',
        CRAFTEDAI_API_ORIGIN: 'https://api.staging.craftedai.co',
        CRAFTEDAI_CHAT_ORIGIN: 'https://chat.staging.craftedai.co',
      },
      requireDelegation: false,
    });
    expect(craftedai.config.publicUrl).toEqual([
      'https://mcp.shop.example/mcp',
      'https://mcp2.shop.example/mcp',
    ]);
    expect(craftedai.config.apiOrigin).toBe('https://api.staging.craftedai.co');
    expect(craftedai.cspDirectives()).toEqual({
      'script-src': ['https://chat.staging.craftedai.co'],
      'frame-src': ['https://chat.staging.craftedai.co'],
    });
  });
});

describe('origin validation (review correction 2)', () => {
  const BAD_ORIGINS = [
    'http://api.craftedai.co',
    'https://api.craftedai.co/',
    'https://api.craftedai.co/v1',
    'https://api.craftedai.co?x=1',
    'https://api.craftedai.co#frag',
    'https://user:pw@api.craftedai.co',
    'https://api.craftedai.co:443',
    'ftp://api.craftedai.co',
    'javascript:alert(1)',
    'not a url',
    '',
  ];

  it.each(BAD_ORIGINS)('refuses apiOrigin %j', (apiOrigin) => {
    const error = constructionError(
      () => new CraftedAI({ apiOrigin, env: {}, requireDelegation: false }),
    );
    expect(error.code).toBe('config_invalid');
    expect(error.message).toContain('apiOrigin');
  });

  it.each(BAD_ORIGINS.filter((origin) => origin !== ''))('refuses chatOrigin %j', (chatOrigin) => {
    const error = constructionError(
      () => new CraftedAI({ chatOrigin, env: {}, requireDelegation: false }),
    );
    expect(error.code).toBe('config_invalid');
    expect(error.message).toContain('chatOrigin');
  });

  it('refuses a bad origin that comes from the environment', () => {
    expect(
      constructionError(
        () =>
          new CraftedAI({
            env: { CRAFTEDAI_API_ORIGIN: 'https://api.x.test/' },
            requireDelegation: false,
          }),
      ).message,
    ).toContain('apiOrigin');
    expect(
      constructionError(
        () =>
          new CraftedAI({
            env: { CRAFTEDAI_CHAT_ORIGIN: 'http://chat.x.test' },
            requireDelegation: false,
          }),
      ).message,
    ).toContain('chatOrigin');
  });

  it.each(['http://localhost', 'http://localhost:3000', 'http://127.0.0.1:8080'])(
    'allows %s for local development',
    (origin) => {
      const craftedai = new CraftedAI({
        apiOrigin: origin,
        chatOrigin: origin,
        env: {},
        requireDelegation: false,
      });
      expect(craftedai.config.apiOrigin).toBe(origin);
      expect(craftedai.config.chatOrigin).toBe(origin);
    },
  );

  it('does not widen the http exception to other hosts', () => {
    expect(
      () =>
        new CraftedAI({
          apiOrigin: 'http://localhost.evil.test',
          env: {},
          requireDelegation: false,
        }),
    ).toThrow(/apiOrigin/);
  });
});

describe('requireDelegation needs an app secret (review correction 2)', () => {
  it('throws config_invalid at construction when delegation is required (the default) and there is none', () => {
    const error = constructionError(() => new CraftedAI({ env: {} }));
    expect(error.code).toBe('config_invalid');
    expect(error.message).toContain('CRAFTEDAI_APP_SECRET');
  });

  it('also throws when requireDelegation is explicitly true', () => {
    expect(() => new CraftedAI({ requireDelegation: true, env: {} })).toThrow(/APP_SECRET/);
  });

  it('constructs without one when delegation is not required', () => {
    expect(() => new CraftedAI({ requireDelegation: false, env: {} })).not.toThrow();
  });
});

describe('published test-vector material is refused (review correction 3)', () => {
  const VECTOR_SECRET = vectors.config.appSecret;

  it.each([
    ['appSecret option', { appSecret: VECTOR_SECRET }],
    ['previousAppSecret option', { appSecret: APP_SECRET, previousAppSecret: VECTOR_SECRET }],
    ['CRAFTEDAI_APP_SECRET', { env: { CRAFTEDAI_APP_SECRET: VECTOR_SECRET } }],
    [
      'CRAFTEDAI_APP_SECRET_PREVIOUS',
      { env: { CRAFTEDAI_APP_SECRET: APP_SECRET, CRAFTEDAI_APP_SECRET_PREVIOUS: VECTOR_SECRET } },
    ],
  ])('refuses it as %s, without echoing it', (_label, options) => {
    const error = constructionError(() => new CraftedAI({ env: {}, ...options }));
    expect(error.code).toBe('config_invalid');
    expect(error.message).toMatch(/test/i);
    expect(error.message).not.toContain(VECTOR_SECRET);
  });

  it('refuses it even when delegation is not required', () => {
    expect(
      () => new CraftedAI({ appSecret: VECTOR_SECRET, requireDelegation: false, env: {} }),
    ).toThrow(/test/i);
  });
});

describe('app secret rotation (CRAFTEDAI_APP_SECRET_PREVIOUS)', () => {
  const PREVIOUS = 'Q0hBTkdFLU1FLW9sZC1hcHAtc2VjcmV0LTQzLWNoYXJzLXg';

  it('reads it from the env and still mints with the current secret only', async () => {
    const stub = coreApiStub(() => jsonResponse(201, MINT_RESPONSE));
    const craftedai = new CraftedAI({
      fetch: stub.fetch,
      now: () => NOW_MS,
      env: { ...WEB_ENV, CRAFTEDAI_APP_SECRET_PREVIOUS: PREVIOUS },
    });
    expect(craftedai.config.previousAppSecret).toBe(PREVIOUS);

    await craftedai.createSession({
      externalUserId: 'member-1',
      agentId: AGENT_ID,
      hostOrigin: 'https://shop.example',
    });

    const sent = JSON.parse(String(stub.calls[0]!.init.body)) as { delegation: { token: string } };
    const check = (appSecret: string) =>
      verifyDelegationToken(sent.delegation.token, {
        appSecret,
        orgId: ORG_ID,
        nowSeconds: NOW_S,
      });
    expect(await check(APP_SECRET)).not.toBeNull();
    expect(await check(PREVIOUS)).toBeNull();
  });

  it('lets the MCP guard accept a delegation signed with the previous secret', async () => {
    const signer = await createOwnSigner(ISSUER, ORG_ID);
    const guard = (previousAppSecret?: string) =>
      new CraftedAI({
        apiOrigin: ISSUER,
        orgId: ORG_ID,
        // The web app already moved to a new secret; the delegation below is still signed with the old one.
        appSecret: APP_SECRET,
        ...(previousAppSecret === undefined ? {} : { previousAppSecret }),
        env: {},
        now: () => NOW_MS,
        fetch: signer.fetch,
      });
    const call = async () => {
      const { token } = await mintDelegationToken({
        appSecret: PREVIOUS,
        orgId: ORG_ID,
        externalUserId: 'member-1',
        nowSeconds: NOW_S,
      });
      return new Request(MCP_URL, {
        method: 'POST',
        headers: {
          'x-craftedai-request': await signer.sign({
            aud: MCP_URL,
            body: BODY,
            nowSeconds: NOW_S,
            act: { externalUserId: 'member-1', channel: 'api', conversationId: 'conv-1' },
          }),
          'x-craftedai-actor-delegation': token,
        },
        body: BODY,
      });
    };

    expect(await guard(PREVIOUS).verifyMcpRequest(await call())).toMatchObject({ ok: true });
    expect(await guard().verifyMcpRequest(await call())).toEqual({
      ok: false,
      reason: 'delegation_invalid',
    });
  });

  it('is optional: unset or blank means no overlap', () => {
    expect(
      new CraftedAI({ requireDelegation: false, env: {} }).config.previousAppSecret,
    ).toBeUndefined();
    expect(
      new CraftedAI({ requireDelegation: false, env: { CRAFTEDAI_APP_SECRET_PREVIOUS: '  ' } })
        .config.previousAppSecret,
    ).toBeUndefined();
  });

  it('refuses a malformed previous secret at construction, without echoing it', () => {
    const construct = () =>
      new CraftedAI({
        requireDelegation: false,
        env: { CRAFTEDAI_APP_SECRET_PREVIOUS: 'tiny-old-value' },
      });
    expect(construct).toThrow(/CRAFTEDAI_APP_SECRET_PREVIOUS/);
    expect(construct).not.toThrow(/tiny-old-value/);
  });
});

describe('the verifier as the client wires it', () => {
  const act = { externalUserId: 'member-1', channel: 'api', conversationId: 'conv-1' };

  async function client(replayStore?: ReplayStore) {
    const signer = await createOwnSigner(ISSUER, ORG_ID);
    const craftedai = new CraftedAI({
      apiOrigin: ISSUER,
      orgId: ORG_ID,
      appSecret: APP_SECRET,
      requireDelegation: false,
      env: {},
      now: () => NOW_MS,
      fetch: signer.fetch,
      ...(replayStore === undefined ? {} : { replayStore }),
    });
    const request = async () =>
      new Request(MCP_URL, {
        method: 'POST',
        headers: {
          'x-craftedai-request': await signer.sign({
            aud: MCP_URL,
            body: BODY,
            nowSeconds: NOW_S,
            act,
          }),
        },
        body: BODY,
      });
    return { craftedai, request, signer };
  }

  it('verifies a request signed with a key from the JWKS', async () => {
    const { craftedai, request } = await client();
    expect(await craftedai.verifyMcpRequest(await request())).toMatchObject({
      ok: true,
      context: { orgId: ORG_ID, user: 'member-1', delegated: false },
    });
  });

  it('never trusts the published test-vector signing keys (the constructor does not allow them)', async () => {
    const verifier = new CraftedAI({
      apiOrigin: vectors.config.issuer,
      orgId: vectors.config.orgId,
      requireDelegation: false,
      env: {},
      now: () => VECTOR_NOW * 1000,
      fetch: (() =>
        Promise.resolve(new Response(JSON.stringify(vectors.jwks)))) as unknown as typeof fetch,
    });
    const request = new Request(vectors.config.publicUrl, {
      method: 'POST',
      headers: { 'x-craftedai-request': await signRequest({ body: BODY }) },
      body: BODY,
    });
    expect(await verifier.verifyMcpRequest(request)).toMatchObject({
      ok: false,
      reason: 'unknown_key',
    });
  });

  it.each(['recordRequest', 'has'] as const)(
    'rethrows when the replay store fails in %s: an outage is never a pass (review correction 7)',
    async (failing) => {
      const store: ReplayStore = {
        has: () => Promise.resolve(false),
        markOnce: () => Promise.resolve(true),
        count: () => Promise.resolve(0),
        increment: () => Promise.resolve(1),
        recordRequest: () => Promise.resolve('recorded'),
        [failing]: () => Promise.reject(new Error('redis down')),
      };
      const { craftedai, request } = await client(store);
      await expect(craftedai.verifyMcpRequest(await request())).rejects.toThrow('redis down');
    },
  );
});

describe('CSP output (review correction 6)', () => {
  it('writes the string form with ; separators', () => {
    const craftedai = new CraftedAI({ requireDelegation: false, env: {} });
    expect(craftedai.cspDirectiveString()).toBe(
      'script-src https://chat.craftedai.co; frame-src https://chat.craftedai.co;',
    );
  });
});

const PREVIOUS_SECRET = 'Q0hBTkdFLU1FLW9sZC1hcHAtc2VjcmV0LTQzLWNoYXJzLXg';

describe('secrets never leak through serialisation or logging (fix round 1)', () => {
  const build = () =>
    new CraftedAI({
      secretKey: SECRET_KEY,
      appSecret: APP_SECRET,
      previousAppSecret: PREVIOUS_SECRET,
      orgId: ORG_ID,
      env: {},
    });

  it.each([SECRET_KEY, APP_SECRET, PREVIOUS_SECRET])(
    'hides %s from every printed form',
    (secret) => {
      for (const [how, text] of Object.entries(printed(build()))) {
        expect(text, how).not.toContain(secret);
      }
    },
  );

  it('still reads the secrets as properties, and shows the non-secret config', () => {
    const client = build();
    expect(client.config.secretKey).toBe(SECRET_KEY);
    expect(client.config.appSecret).toBe(APP_SECRET);
    expect(client.config.previousAppSecret).toBe(PREVIOUS_SECRET);
    expect(Object.keys(client.config)).not.toEqual(expect.arrayContaining(['secretKey']));
    expect(JSON.parse(JSON.stringify(client))).toMatchObject({
      config: {
        apiOrigin: 'https://api.craftedai.co',
        orgId: ORG_ID,
        secretKey: '[redacted]',
        appSecret: '[redacted]',
        previousAppSecret: '[redacted]',
      },
    });
  });

  it.each(['secretKey', 'appSecret', 'previousAppSecret'] as const)(
    'makes config.%s non-enumerable',
    (field) => {
      const config = build().config;
      expect(Object.keys(config)).not.toContain(field);
      const descriptor = Object.getOwnPropertyDescriptor(config, field);
      // A getter over module-private storage: no value on the object, no setter, not enumerable.
      expect(descriptor).toMatchObject({ enumerable: false, set: undefined });
      expect(descriptor?.get).toBeTypeOf('function');
      expect(descriptor).not.toHaveProperty('value');
    },
  );

  it('types the config fields readonly, and a write to a secret throws at runtime', () => {
    const config = build().config;
    expect(() => {
      // @ts-expect-error ResolvedConfig fields are readonly
      config.appSecret = 'overwritten';
    }).toThrow(TypeError);
    expect(config.appSecret).toBe(APP_SECRET);
  });
});
