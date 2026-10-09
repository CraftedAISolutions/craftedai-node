import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import {
  AGENT_ID,
  coreApiStub,
  jsonResponse,
  MINT_RESPONSE,
} from '../../test/helpers/core-api-stub.js';
import { craftedaiForVectors, signRequest } from '../../test/helpers/craftedai-for-vectors.js';
import { failingReplayStore, OUTAGE_MESSAGE } from '../../test/helpers/failing-replay-store.js';
import { VECTOR_CONFIG } from '../../test/helpers/sign.js';
import type { CraftedAI } from '../craftedai.js';
import { CraftedAIError } from '../errors.js';

const BODY = '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}';
const SECRET_KEY = `cai_${'k'.repeat(43)}`;

async function app(
  craftedai: CraftedAI = craftedaiForVectors({ publicUrl: VECTOR_CONFIG.publicUrl }),
  protectOptions: { maxBodyBytes?: number } = {},
  reached: () => void = () => undefined,
) {
  const fastify = Fastify();
  await fastify.register(async (mcp) => {
    craftedai.fastify.protect(mcp, protectOptions);
    mcp.post('/mcp', (request) => {
      reached();
      return { context: craftedai.fastify.context(request), body: request.body };
    });
  });
  fastify.post('/other', (request) => ({ body: request.body }));
  return fastify;
}

const mcpHeaders = async (body: string, aud?: string) => ({
  'content-type': 'application/json',
  'x-craftedai-request': await signRequest({ body, ...(aud !== undefined ? { aud } : {}) }),
});

describe('fastify.protect()', () => {
  it('verifies the exact bytes and exposes the context and parsed body', async () => {
    const fastify = await app();
    const res = await fastify.inject({
      method: 'POST',
      url: '/mcp',
      headers: await mcpHeaders(BODY),
      payload: BODY,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      context: { orgId: VECTOR_CONFIG.orgId, user: null },
      body: JSON.parse(BODY),
    });
  });

  it('401s a body that differs by one byte', async () => {
    const fastify = await app();
    const res = await fastify.inject({
      method: 'POST',
      url: '/mcp',
      headers: await mcpHeaders(BODY),
      payload: `${BODY} `,
    });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ reason: 'body_mismatch' });
  });

  it('leaves routes outside the protected scope alone', async () => {
    const fastify = await app();
    const res = await fastify.inject({ method: 'POST', url: '/other', payload: { a: 1 } });
    expect(res.json()).toEqual({ body: { a: 1 } });
  });

  describe('audience URL (review correction 1)', () => {
    const HOST = 'fastify.internal:8080';

    it('without publicUrl, the protocol, Host and path Fastify sees are the audience', async () => {
      const fastify = await app(craftedaiForVectors());
      const res = await fastify.inject({
        method: 'POST',
        url: '/mcp',
        headers: { ...(await mcpHeaders(BODY, `http://${HOST}/mcp`)), host: HOST },
        payload: BODY,
      });
      expect(res.statusCode).toBe(200);
    });

    it('a spoofed X-Forwarded-Host / -Proto / Forwarded does not change the audience', async () => {
      const fastify = await app(craftedaiForVectors());
      const publicUrl = new URL(VECTOR_CONFIG.publicUrl);
      const res = await fastify.inject({
        method: 'POST',
        url: '/mcp',
        headers: {
          ...(await mcpHeaders(BODY)),
          host: HOST,
          'x-forwarded-host': publicUrl.host,
          'x-forwarded-proto': 'https',
          forwarded: `host=${publicUrl.host};proto=https`,
        },
        payload: BODY,
      });
      expect(res.statusCode).toBe(401);
      const body = res.json<{ reason: string; message: string }>();
      expect(body.reason).toBe('wrong_audience');
      expect(body.message).toContain(`reached at http://${HOST}/mcp`);
    });

    it('excludes the query string', async () => {
      const fastify = await app(craftedaiForVectors());
      const res = await fastify.inject({
        method: 'POST',
        url: '/mcp?session=abc',
        headers: { ...(await mcpHeaders(BODY, `http://${HOST}/mcp`)), host: HOST },
        payload: BODY,
      });
      expect(res.statusCode).toBe(200);
      const withQuery = await fastify.inject({
        method: 'POST',
        url: '/mcp?session=abc',
        headers: { ...(await mcpHeaders(BODY, `http://${HOST}/mcp?session=abc`)), host: HOST },
        payload: BODY,
      });
      expect(withQuery.json<{ reason: string }>().reason).toBe('wrong_audience');
    });
  });

  describe('a verifier that rejects (review correction 2)', () => {
    it.each(['has', 'recordRequest'] as const)(
      'answers 503 with Retry-After, never runs the handler, never echoes the error (%s down)',
      async (method) => {
        const onError = vi.fn();
        const reached = vi.fn();
        const craftedai = craftedaiForVectors({
          publicUrl: VECTOR_CONFIG.publicUrl,
          replayStore: failingReplayStore(method),
          onError,
        });
        const fastify = await app(craftedai, {}, reached);
        const res = await fastify.inject({
          method: 'POST',
          url: '/mcp',
          headers: await mcpHeaders(BODY),
          payload: BODY,
        });
        expect(res.statusCode).toBe(503);
        expect(res.headers['retry-after']).toBe('5');
        expect(reached).not.toHaveBeenCalled();
        expect(res.body).not.toContain('hunter2');
        expect(res.body).not.toContain('ECONNREFUSED');
        expect(res.json()).toEqual({ error: 'craftedai_verification_unavailable' });
        expect(onError).toHaveBeenCalledOnce();
        expect((onError.mock.calls[0]?.[0] as Error).message).toBe(OUTAGE_MESSAGE);
      },
    );
  });

  it('a misconfigured client (CraftedAIError config_*) stays a 500, without Retry-After', async () => {
    const craftedai = craftedaiForVectors({
      publicUrl: VECTOR_CONFIG.publicUrl,
      replayStore: failingReplayStore('has', new CraftedAIError('config_invalid', 'bad store')),
    });
    const fastify = await app(craftedai);
    const res = await fastify.inject({
      method: 'POST',
      url: '/mcp',
      headers: await mcpHeaders(BODY),
      payload: BODY,
    });
    expect(res.statusCode).toBe(500);
    expect(res.headers['retry-after']).toBeUndefined();
  });

  describe('body cap', () => {
    it('Fastify refuses a body over maxBodyBytes with 413 and the shared body, before the handler', async () => {
      const reached = vi.fn();
      const fastify = await app(undefined, { maxBodyBytes: 100 }, reached);
      const res = await fastify.inject({
        method: 'POST',
        url: '/mcp',
        headers: { 'content-type': 'text/plain' },
        payload: 'a'.repeat(101),
      });
      expect(res.statusCode).toBe(413);
      expect(res.json()).toEqual({ error: 'payload_too_large' });
      expect(res.headers['content-type']).toContain('application/json');
      expect(reached).not.toHaveBeenCalled();
    });

    it('the 413 handler is scoped: other errors reach the parent error handler', async () => {
      const craftedai = craftedaiForVectors({ publicUrl: VECTOR_CONFIG.publicUrl });
      const fastify = Fastify();
      fastify.setErrorHandler((error, _request, reply) =>
        reply.code(418).send({ parent: (error as Error).message }),
      );
      await fastify.register(async (mcp) => {
        craftedai.fastify.protect(mcp);
        mcp.post('/boom', () => {
          throw new Error('handler failed');
        });
      });
      fastify.post('/outside', () => {
        throw new Error('outside failed');
      });
      const inside = await fastify.inject({
        method: 'POST',
        url: '/boom',
        headers: await mcpHeaders(BODY),
        payload: BODY,
      });
      expect(inside.statusCode).toBe(418);
      expect(inside.json()).toEqual({ parent: 'handler failed' });
      const outside = await fastify.inject({ method: 'POST', url: '/outside' });
      expect(outside.json()).toEqual({ parent: 'outside failed' });
    });

    it('rejects an invalid maxBodyBytes when protect() is called', async () => {
      const fastify = Fastify();
      expect(() => {
        craftedaiForVectors().fastify.protect(fastify, { maxBodyBytes: 0 });
      }).toThrow(expect.objectContaining({ code: 'config_invalid' }) as Error);
    });
  });
});

describe('fastify.sessionHandler()', () => {
  async function sessionApp(craftedai: CraftedAI, getUser: () => string | undefined) {
    const fastify = Fastify();
    fastify.post('/craftedai/session', craftedai.fastify.sessionHandler({ getUser }));
    return fastify;
  }
  const post = (fastify: Awaited<ReturnType<typeof sessionApp>>, headers = {}) =>
    fastify.inject({
      method: 'POST',
      url: '/craftedai/session',
      headers: { 'content-type': 'application/json', origin: 'https://shop.example', ...headers },
      payload: { agentId: AGENT_ID },
    });

  it('mints for the signed-in user', async () => {
    const stub = coreApiStub(() => jsonResponse(201, MINT_RESPONSE));
    const craftedai = craftedaiForVectors({ secretKey: SECRET_KEY, fetch: stub.fetch });
    const res = await post(await sessionApp(craftedai, () => 'member-1'));
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.json()).toMatchObject({ token: MINT_RESPONSE.embedSession.token });
  });

  it('401 when signed out, 415 for non-JSON', async () => {
    const craftedai = craftedaiForVectors({ secretKey: SECRET_KEY });
    expect((await post(await sessionApp(craftedai, () => undefined))).statusCode).toBe(401);
    const text = await (
      await sessionApp(craftedai, () => 'member-1')
    ).inject({
      method: 'POST',
      url: '/craftedai/session',
      headers: { 'content-type': 'text/plain', origin: 'https://shop.example' },
      payload: 'x',
    });
    expect(text.statusCode).toBe(415);
  });

  it('502 plus onError for an unexpected mint failure, 404 and 403 without', async () => {
    const onError = vi.fn();
    const run = async (status: number, body: unknown) => {
      const stub = coreApiStub(() => jsonResponse(status, body));
      const craftedai = craftedaiForVectors({ secretKey: SECRET_KEY, fetch: stub.fetch, onError });
      return post(await sessionApp(craftedai, () => 'member-1'));
    };
    expect((await run(404, {})).statusCode).toBe(404);
    expect((await run(403, { error: 'embed_origin_not_allowed' })).statusCode).toBe(403);
    expect(onError).not.toHaveBeenCalled();
    expect((await run(500, {})).statusCode).toBe(502);
    expect(onError).toHaveBeenCalledOnce();
  });

  it('500 plus onError when getUser throws, never echoing the error', async () => {
    const onError = vi.fn();
    const craftedai = craftedaiForVectors({ secretKey: SECRET_KEY, onError });
    const res = await post(
      await sessionApp(craftedai, () => {
        throw new Error('session store password=hunter2');
      }),
    );
    expect(res.statusCode).toBe(500);
    expect(res.body).not.toContain('hunter2');
    expect(onError).toHaveBeenCalledOnce();
  });

  it('throws config_invalid at build time for a bad ttlSeconds', () => {
    const craftedai = craftedaiForVectors({ secretKey: SECRET_KEY });
    let thrown: unknown;
    try {
      craftedai.fastify.sessionHandler({ getUser: () => 'u', ttlSeconds: 5 });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(CraftedAIError);
    expect((thrown as CraftedAIError).code).toBe('config_invalid');
  });
});
