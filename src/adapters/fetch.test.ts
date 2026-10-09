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
import { CraftedAIError } from '../errors.js';

const BODY = '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}';
const SECRET_KEY = `cai_${'k'.repeat(43)}`;

describe('fetch adapter', () => {
  it('verifyRequest passes an unread request and the context to the handler', async () => {
    const craftedai = craftedaiForVectors();
    const handler = craftedai.fetch.verifyRequest(async (request, context) =>
      Response.json({ body: await request.text(), user: context.user }),
    );
    const res = await handler(
      new Request(VECTOR_CONFIG.publicUrl, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-craftedai-request': await signRequest({ body: BODY }),
        },
        body: BODY,
      }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ body: BODY, user: null });
  });

  it('verifyRequest answers 401 JSON on failure', async () => {
    const handler = craftedaiForVectors().fetch.verifyRequest(() => new Response('never'));
    const res = await handler(new Request(VECTOR_CONFIG.publicUrl, { method: 'POST', body: BODY }));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({
      error: 'craftedai_verification_failed',
      reason: 'missing_token',
    });
  });

  describe('audience URL (review correction 1)', () => {
    const post = async (url: string, headers: Record<string, string>, aud?: string) =>
      new Request(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-craftedai-request': await signRequest({
            body: BODY,
            ...(aud !== undefined ? { aud } : {}),
          }),
          ...headers,
        },
        body: BODY,
      });

    it('a spoofed X-Forwarded-Host / -Proto / Forwarded does not change the audience', async () => {
      const handler = craftedaiForVectors().fetch.verifyRequest(() => new Response('never'));
      const publicUrl = new URL(VECTOR_CONFIG.publicUrl);
      const res = await handler(
        await post('http://internal.example:3000/mcp', {
          'x-forwarded-host': publicUrl.host,
          'x-forwarded-proto': 'https',
          forwarded: `host=${publicUrl.host};proto=https`,
        }),
      );
      expect(res.status).toBe(401);
      const body = (await res.json()) as { reason: string; message: string };
      expect(body.reason).toBe('wrong_audience');
      expect(body.message).toContain('reached at http://internal.example:3000/mcp');
    });

    it('excludes the query string', async () => {
      const handler = craftedaiForVectors().fetch.verifyRequest(() => new Response('ok'));
      const ok = await handler(
        await post(`${VECTOR_CONFIG.publicUrl}?session=abc#frag`, {}, VECTOR_CONFIG.publicUrl),
      );
      expect(ok.status).toBe(200);
      const withQuery = await handler(
        await post(`${VECTOR_CONFIG.publicUrl}?x=1`, {}, `${VECTOR_CONFIG.publicUrl}?x=1`),
      );
      expect(((await withQuery.json()) as { reason: string }).reason).toBe('wrong_audience');
    });
  });

  describe('a verifier that rejects (review correction 2)', () => {
    it.each(['has', 'recordRequest'] as const)(
      'answers 500, never runs the handler, never echoes the error (%s down)',
      async (method) => {
        const onError = vi.fn();
        const reached = vi.fn(() => new Response('reached'));
        const craftedai = craftedaiForVectors({
          replayStore: failingReplayStore(method),
          onError,
        });
        const res = await craftedai.fetch.verifyRequest(reached)(
          new Request(VECTOR_CONFIG.publicUrl, {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              'x-craftedai-request': await signRequest({ body: BODY }),
            },
            body: BODY,
          }),
        );
        const text = await res.text();
        expect(res.status).toBe(500);
        expect(reached).not.toHaveBeenCalled();
        expect(text).not.toContain('hunter2');
        expect(text).not.toContain('ECONNREFUSED');
        expect(JSON.parse(text)).toEqual({ error: 'craftedai_verification_unavailable' });
        expect(onError).toHaveBeenCalledOnce();
        expect((onError.mock.calls[0]?.[0] as Error).message).toBe(OUTAGE_MESSAGE);
      },
    );
  });

  describe('sessionHandler', () => {
    const request = (init: RequestInit = {}) =>
      new Request('https://shop.example/craftedai/session', {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: 'https://shop.example' },
        body: JSON.stringify({ agentId: AGENT_ID }),
        ...init,
      });

    it('mints from a Web Request', async () => {
      const stub = coreApiStub(() => jsonResponse(201, MINT_RESPONSE));
      const craftedai = craftedaiForVectors({ secretKey: SECRET_KEY, fetch: stub.fetch });
      const handler = craftedai.fetch.sessionHandler({ getUser: () => 'member-1' });
      const res = await handler(request());
      expect(res.status).toBe(200);
      expect(res.headers.get('cache-control')).toBe('no-store');
    });

    it('401 signed out, 415 non-JSON, 400 bad agentId, all without onError', async () => {
      const onError = vi.fn();
      const craftedai = craftedaiForVectors({ secretKey: SECRET_KEY, onError });
      const signedOut = craftedai.fetch.sessionHandler({ getUser: () => null });
      expect((await signedOut(request())).status).toBe(401);
      const handler = craftedai.fetch.sessionHandler({ getUser: () => 'member-1' });
      const text = await handler(
        request({
          headers: { 'content-type': 'text/plain', origin: 'https://shop.example' },
        }),
      );
      expect(text.status).toBe(415);
      expect((await handler(request({ body: JSON.stringify({ agentId: 'x' }) }))).status).toBe(400);
      expect(onError).not.toHaveBeenCalled();
    });

    it('404 and 403 are mapped without onError; anything else is 502 plus onError', async () => {
      const onError = vi.fn();
      const run = (status: number, body: unknown) => {
        const stub = coreApiStub(() => jsonResponse(status, body));
        const craftedai = craftedaiForVectors({
          secretKey: SECRET_KEY,
          fetch: stub.fetch,
          onError,
        });
        return craftedai.fetch.sessionHandler({ getUser: () => 'member-1' })(request());
      };
      expect((await run(404, {})).status).toBe(404);
      expect((await run(403, { error: 'agent_not_allowed_for_key' })).status).toBe(403);
      expect(onError).not.toHaveBeenCalled();
      expect((await run(500, {})).status).toBe(502);
      expect(onError).toHaveBeenCalledOnce();
    });

    it('500 plus onError when getUser throws, never echoing the error', async () => {
      const onError = vi.fn();
      const craftedai = craftedaiForVectors({ secretKey: SECRET_KEY, onError });
      const res = await craftedai.fetch.sessionHandler({
        getUser: () => {
          throw new Error('session store password=hunter2');
        },
      })(request());
      expect(res.status).toBe(500);
      expect(await res.text()).not.toContain('hunter2');
      expect(onError).toHaveBeenCalledOnce();
    });

    it('413 for an oversized body', async () => {
      const craftedai = craftedaiForVectors({ secretKey: SECRET_KEY });
      const handler = craftedai.fetch.sessionHandler({ getUser: () => 'member-1' });
      expect((await handler(request({ body: 'a'.repeat(64 * 1024) }))).status).toBe(413);
    });

    it('throws config_invalid at build time for a bad ttlSeconds', () => {
      const craftedai = craftedaiForVectors({ secretKey: SECRET_KEY });
      let thrown: unknown;
      try {
        craftedai.fetch.sessionHandler({ getUser: () => 'u', ttlSeconds: 1801 });
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(CraftedAIError);
      expect((thrown as CraftedAIError).code).toBe('config_invalid');
    });
  });
});
