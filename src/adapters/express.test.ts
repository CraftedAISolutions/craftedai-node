import { connect, type AddressInfo } from 'node:net';
import express from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AGENT_ID,
  coreApiStub,
  jsonResponse,
  MINT_RESPONSE,
} from '../../test/helpers/core-api-stub.js';
import {
  craftedaiForVectors,
  delegationFor,
  signRequest,
} from '../../test/helpers/craftedai-for-vectors.js';
import { failingReplayStore, OUTAGE_MESSAGE } from '../../test/helpers/failing-replay-store.js';
import { VECTOR_CONFIG } from '../../test/helpers/sign.js';
import type { CraftedAI } from '../craftedai.js';
import { CraftedAIError } from '../errors.js';
import { MAX_BODY_BYTES } from './node-body.js';

const BODY =
  '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"get_order","arguments":{}}}';
const ACT = { externalUserId: 'member-1', channel: 'api', conversationId: 'c-1' } as const;
const SECRET_KEY = `cai_${'k'.repeat(43)}`;

let close: (() => void) | undefined;
afterEach(() => close?.());

async function listen(app: express.Express): Promise<string> {
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  close = () => {
    server.closeAllConnections();
    server.close();
  };
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

function mcpApp(
  craftedai = craftedaiForVectors({ publicUrl: VECTOR_CONFIG.publicUrl }),
  parserFirst = false,
) {
  const app = express();
  if (parserFirst) app.use(express.json());
  app.post('/mcp', craftedai.express.verifyRequest(), express.json(), (req, res) => {
    res.json({ craftedai: req.craftedai, body: req.body, raw: req.rawBody?.length });
  });
  return app;
}

describe('express.verifyRequest()', () => {
  it('verifies the raw bytes, then hands the handler req.craftedai and the parsed body', async () => {
    const base = await listen(mcpApp());
    const res = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-craftedai-request': await signRequest({ body: BODY, act: ACT }),
        'x-craftedai-actor-delegation': await delegationFor('member-1'),
      },
      body: BODY,
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { craftedai: unknown; body: unknown; raw: number };
    expect(json.craftedai).toMatchObject({
      orgId: VECTOR_CONFIG.orgId,
      user: 'member-1',
      delegated: true,
    });
    expect(json.body).toEqual(JSON.parse(BODY));
    expect(json.raw).toBe(Buffer.byteLength(BODY));
  });

  it('answers 401 with the frozen body on failure', async () => {
    const base = await listen(mcpApp());
    const res = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: BODY,
    });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({
      error: 'craftedai_verification_failed',
      reason: 'missing_token',
    });
  });

  it('spec §12.3: express.json() mounted first → body_mismatch naming the parser', async () => {
    const base = await listen(mcpApp(undefined, true));
    const res = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-craftedai-request': await signRequest({ body: BODY }),
      },
      body: BODY,
    });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { reason: string; message: string };
    expect(body.reason).toBe('body_mismatch');
    expect(body.message).toContain('already read by a body parser mounted before verifyRequest()');
  });

  it('spec §12.1: without publicUrl, the URL Express sees is the audience', async () => {
    const base = await listen(mcpApp(craftedaiForVectors()));
    const signedForPublic = await signRequest({ body: BODY });
    const res = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-craftedai-request': signedForPublic },
      body: BODY,
    });
    const body = (await res.json()) as { reason: string; message: string };
    expect(body.reason).toBe('wrong_audience');
    expect(body.message).toContain(`${base}/mcp`);
    const ok = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-craftedai-request': await signRequest({ body: BODY, aud: `${base}/mcp` }),
      },
      body: BODY,
    });
    expect(ok.status).toBe(200);
  });

  describe('audience URL (review correction 1)', () => {
    it('a spoofed X-Forwarded-Host / -Proto / Forwarded does not change the audience', async () => {
      const base = await listen(mcpApp(craftedaiForVectors()));
      const publicUrl = new URL(VECTOR_CONFIG.publicUrl);
      const res = await fetch(`${base}/mcp`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-craftedai-request': await signRequest({ body: BODY }),
          'x-forwarded-host': publicUrl.host,
          'x-forwarded-proto': 'https',
          forwarded: `host=${publicUrl.host};proto=https`,
        },
        body: BODY,
      });
      expect(res.status).toBe(401);
      const body = (await res.json()) as { reason: string; message: string };
      expect(body.reason).toBe('wrong_audience');
      expect(body.message).toContain(`reached at ${base}/mcp`);
    });

    it('excludes the query string: a request to /mcp?x=1 has the audience /mcp', async () => {
      const base = await listen(mcpApp(craftedaiForVectors()));
      const headers = async (aud: string) => ({
        'content-type': 'application/json',
        'x-craftedai-request': await signRequest({ body: BODY, aud }),
      });
      const ok = await fetch(`${base}/mcp?session=abc&x=1`, {
        method: 'POST',
        headers: await headers(`${base}/mcp`),
        body: BODY,
      });
      expect(ok.status).toBe(200);
      // A token whose audience carries the query is not accepted: the query is never part of it.
      const withQuery = await fetch(`${base}/mcp?x=1`, {
        method: 'POST',
        headers: await headers(`${base}/mcp?x=1`),
        body: BODY,
      });
      expect(((await withQuery.json()) as { reason: string }).reason).toBe('wrong_audience');
    });

    it("honours Express's own trust proxy opt-in for the protocol only", async () => {
      const app = express();
      app.set('trust proxy', true);
      app.post('/mcp', craftedaiForVectors().express.verifyRequest(), (_req, res) => {
        res.json({ ok: true });
      });
      const base = await listen(app);
      const host = new URL(base).host;
      const res = await fetch(`${base}/mcp`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-craftedai-request': await signRequest({ body: BODY, aud: `https://${host}/mcp` }),
          'x-forwarded-proto': 'https',
          // Still ignored: Express's trust proxy would honour it, this adapter reads Host only.
          'x-forwarded-host': 'attacker.example',
        },
        body: BODY,
      });
      expect(res.status).toBe(200);
    });

    it('uses the mounted full path (originalUrl), not the router-relative one', async () => {
      const craftedai = craftedaiForVectors();
      const router = express.Router();
      router.post('/mcp', craftedai.express.verifyRequest(), (_req, res) => res.json({ ok: true }));
      const app = express();
      app.use('/api/v1', router);
      const base = await listen(app);
      const res = await fetch(`${base}/api/v1/mcp`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-craftedai-request': await signRequest({ body: BODY, aud: `${base}/api/v1/mcp` }),
        },
        body: BODY,
      });
      expect(res.status).toBe(200);
    });
  });

  describe('a verifier that rejects (review correction 2)', () => {
    it.each(['has', 'recordRequest'] as const)(
      'answers 500, never runs the handler, never echoes the error (%s down)',
      async (method) => {
        const onError = vi.fn();
        const reached = vi.fn();
        const craftedai = craftedaiForVectors({
          publicUrl: VECTOR_CONFIG.publicUrl,
          replayStore: failingReplayStore(method),
          onError,
        });
        const app = express();
        app.post('/mcp', craftedai.express.verifyRequest(), (_req, res) => {
          reached();
          res.json({ reached: true });
        });
        const base = await listen(app);
        const res = await fetch(`${base}/mcp`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-craftedai-request': await signRequest({ body: BODY }),
          },
          body: BODY,
        });
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

    it('answers 500 even when onError itself throws', async () => {
      const craftedai = craftedaiForVectors({
        publicUrl: VECTOR_CONFIG.publicUrl,
        replayStore: failingReplayStore('has'),
        onError: () => {
          throw new Error('logger down');
        },
      });
      const base = await listen(mcpApp(craftedai));
      const res = await fetch(`${base}/mcp`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-craftedai-request': await signRequest({ body: BODY }),
        },
        body: BODY,
      });
      expect(res.status).toBe(500);
    });
  });

  describe('raw body cap (review correction 3)', () => {
    const post = async (base: string, body: BodyInit, init: RequestInit = {}) =>
      fetch(`${base}/mcp`, {
        method: 'POST',
        headers: { 'content-type': 'text/plain' },
        body,
        ...init,
      });

    it('defaults to 1 MiB: a larger declared body is refused 413 before the handler', async () => {
      expect(MAX_BODY_BYTES).toBe(1024 * 1024);
      const reached = vi.fn();
      const app = express();
      app.post('/mcp', craftedaiForVectors().express.verifyRequest(), (_req, res) => {
        reached();
        res.end();
      });
      const base = await listen(app);
      const res = await post(base, 'a'.repeat(MAX_BODY_BYTES + 1));
      expect(res.status).toBe(413);
      expect(await res.json()).toEqual({ error: 'payload_too_large' });
      expect(reached).not.toHaveBeenCalled();
    });

    it('is configurable: maxBodyBytes admits a body of exactly the cap and refuses one more byte', async () => {
      const craftedai = craftedaiForVectors({ publicUrl: VECTOR_CONFIG.publicUrl });
      const app = express();
      app.post('/mcp', craftedai.express.verifyRequest({ maxBodyBytes: 100 }), (req, res) => {
        res.json({ raw: req.rawBody?.length });
      });
      const base = await listen(app);
      const exact = 'a'.repeat(100);
      const ok = await fetch(`${base}/mcp`, {
        method: 'POST',
        headers: {
          'content-type': 'text/plain',
          'x-craftedai-request': await signRequest({ body: exact }),
        },
        body: exact,
      });
      expect(ok.status).toBe(200);
      expect(await ok.json()).toEqual({ raw: 100 });
      expect((await post(base, 'a'.repeat(101))).status).toBe(413);
    });

    it('refuses on the declared Content-Length alone, without waiting for the body', async () => {
      const reached = vi.fn();
      const app = express();
      app.post('/mcp', craftedaiForVectors().express.verifyRequest(), (_req, res) => {
        reached();
        res.end();
      });
      const base = await listen(app);
      // Headers announce 10 MiB, then no byte of body is ever sent: only a Content-Length
      // check can answer; a guard that waits for the stream would hang.
      const head = await new Promise<string>((resolve, reject) => {
        const socket = connect(Number(new URL(base).port), '127.0.0.1', () => {
          socket.write(
            `POST /mcp HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: text/plain\r\nContent-Length: ${10 * 1024 * 1024}\r\n\r\n`,
          );
        });
        socket.once('data', (chunk: Buffer) => {
          socket.destroy();
          resolve(chunk.toString('utf8'));
        });
        socket.once('error', reject);
      });
      expect(head.split('\r\n')[0]).toBe('HTTP/1.1 413 Payload Too Large');
      expect(reached).not.toHaveBeenCalled();
    });

    it('counts streamed bytes too: a chunked body with no Content-Length is cut off at the cap', async () => {
      const app = express();
      app.post(
        '/mcp',
        craftedaiForVectors().express.verifyRequest({ maxBodyBytes: 100 }),
        (_req, res) => res.end(),
      );
      const base = await listen(app);
      const chunk = new TextEncoder().encode('a'.repeat(60));
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(chunk);
          controller.enqueue(chunk);
          controller.close();
        },
      });
      const res = await post(base, stream, { duplex: 'half' } as RequestInit);
      expect(res.status).toBe(413);
    });

    it.each([0, -1, 1.5, Number.NaN])(
      'rejects maxBodyBytes %s when the guard is built',
      (value) => {
        expect(() => craftedaiForVectors().express.verifyRequest({ maxBodyBytes: value })).toThrow(
          expect.objectContaining({ code: 'config_invalid' }) as Error,
        );
      },
    );
  });
});

function sessionApp(
  craftedai: CraftedAI,
  options = { getUser: () => 'member-1' as string | null },
) {
  const app = express();
  app.post('/craftedai/session', craftedai.express.sessionHandler(options));
  return app;
}

const postSession = (base: string, init: RequestInit = {}) =>
  fetch(`${base}/craftedai/session`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: 'https://shop.example' },
    body: JSON.stringify({ agentId: AGENT_ID }),
    ...init,
  });

describe('express.sessionHandler()', () => {
  it('mints for the signed-in user and returns the widget boot payload', async () => {
    const stub = coreApiStub(() => jsonResponse(201, MINT_RESPONSE));
    const craftedai = craftedaiForVectors({ secretKey: SECRET_KEY, fetch: stub.fetch });
    const base = await listen(sessionApp(craftedai));
    const res = await postSession(base);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await res.json()).toMatchObject({
      token: MINT_RESPONSE.embedSession.token,
      refreshBeforeSeconds: 60,
    });
  });

  it('works after express.json() too, and 401s a signed-out user', async () => {
    const craftedai = craftedaiForVectors({ secretKey: SECRET_KEY });
    const app = express();
    app.use(express.json());
    app.post('/craftedai/session', craftedai.express.sessionHandler({ getUser: () => undefined }));
    const base = await listen(app);
    const res = await postSession(base);
    expect(res.status).toBe(401);
  });

  it('works after express.json() for a signed-in user (the parsed body is reused)', async () => {
    const stub = coreApiStub(() => jsonResponse(201, MINT_RESPONSE));
    const craftedai = craftedaiForVectors({ secretKey: SECRET_KEY, fetch: stub.fetch });
    const app = express();
    app.use(express.json());
    app.post('/craftedai/session', craftedai.express.sessionHandler({ getUser: () => 'member-1' }));
    const base = await listen(app);
    expect((await postSession(base)).status).toBe(200);
  });

  describe('route semantics (Ruling 9)', () => {
    const setup = (answer: () => Response) => {
      const onError = vi.fn();
      const stub = coreApiStub(answer);
      const craftedai = craftedaiForVectors({ secretKey: SECRET_KEY, fetch: stub.fetch, onError });
      return { craftedai, onError };
    };

    it('415 for a non-JSON body', async () => {
      const { craftedai, onError } = setup(() => jsonResponse(201, MINT_RESPONSE));
      const base = await listen(sessionApp(craftedai));
      const res = await postSession(base, {
        headers: { 'content-type': 'text/plain', origin: 'https://shop.example' },
      });
      expect(res.status).toBe(415);
      expect(onError).not.toHaveBeenCalled();
    });

    it('400 for a bad agentId or a bad Origin, without onError', async () => {
      const { craftedai, onError } = setup(() => jsonResponse(201, MINT_RESPONSE));
      const base = await listen(sessionApp(craftedai));
      const badAgent = await postSession(base, { body: JSON.stringify({ agentId: 'nope' }) });
      expect(badAgent.status).toBe(400);
      const badOrigin = await postSession(base, {
        headers: { 'content-type': 'application/json', origin: 'null' },
      });
      expect(badOrigin.status).toBe(400);
      expect(onError).not.toHaveBeenCalled();
    });

    it.each([
      [404, 'agent_unavailable', 404],
      [403, 'agent_not_allowed_for_key', 403],
      [403, 'embed_origin_not_allowed', 403],
    ] as const)('maps core-api %i %s to %i without onError', async (status, code, expected) => {
      const { craftedai, onError } = setup(() => jsonResponse(status, { error: code }));
      const base = await listen(sessionApp(craftedai));
      const res = await postSession(base);
      expect(res.status).toBe(expected);
      expect(onError).not.toHaveBeenCalled();
    });

    it('502 plus onError for everything else', async () => {
      const { craftedai, onError } = setup(() => jsonResponse(500, {}));
      const base = await listen(sessionApp(craftedai));
      const res = await postSession(base);
      expect(res.status).toBe(502);
      expect(await res.json()).toEqual({ error: 'session_unavailable' });
      expect(onError).toHaveBeenCalledOnce();
    });

    it('answers 500 plus onError when getUser throws, never echoing the error', async () => {
      const { craftedai, onError } = setup(() => jsonResponse(201, MINT_RESPONSE));
      const base = await listen(
        sessionApp(craftedai, {
          getUser: () => {
            throw new Error('session store password=hunter2');
          },
        }),
      );
      const res = await postSession(base);
      const text = await res.text();
      expect(res.status).toBe(500);
      expect(text).not.toContain('hunter2');
      expect(onError).toHaveBeenCalledOnce();
    });

    it('413 for an oversized body', async () => {
      const { craftedai } = setup(() => jsonResponse(201, MINT_RESPONSE));
      const base = await listen(sessionApp(craftedai));
      const res = await postSession(base, { body: 'a'.repeat(64 * 1024) });
      expect(res.status).toBe(413);
    });
  });

  describe('ttlSeconds is validated when the handler is built (review correction 4)', () => {
    it.each([59, 1801, 90.5, Number.NaN, '900' as unknown as number])(
      'throws config_invalid at build time for ttlSeconds %s',
      (ttlSeconds) => {
        const craftedai = craftedaiForVectors({ secretKey: SECRET_KEY });
        let thrown: unknown;
        try {
          craftedai.express.sessionHandler({ getUser: () => 'u', ttlSeconds });
        } catch (error) {
          thrown = error;
        }
        expect(thrown).toBeInstanceOf(CraftedAIError);
        expect((thrown as CraftedAIError).code).toBe('config_invalid');
      },
    );

    it('accepts the bounds', () => {
      const craftedai = craftedaiForVectors({ secretKey: SECRET_KEY });
      expect(() =>
        craftedai.express.sessionHandler({ getUser: () => 'u', ttlSeconds: 60 }),
      ).not.toThrow();
      expect(() =>
        craftedai.express.sessionHandler({ getUser: () => 'u', ttlSeconds: 1800 }),
      ).not.toThrow();
    });
  });
});
