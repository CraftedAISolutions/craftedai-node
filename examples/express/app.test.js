import { spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CraftedAI } from '@craftedai/node';
import { afterEach, describe, expect, it } from 'vitest';
// The library's own signer helpers: a freshly generated Ed25519 key, never the published vector keys.
import { createOwnSigner } from '../../test/helpers/own-signer.ts';
import { mintDelegationToken } from '../../src/delegation.ts';
import { createApp } from './app.js';

const ISSUER = 'https://api.craftedai.test';
const ORG_ID = randomUUID();
const AGENT_ID = randomUUID();
const APP_SECRET = randomBytes(32).toString('base64url'); // 43 chars, generated per run
const SECRET_KEY = `cai_${randomBytes(32).toString('base64url')}`;
const TOOL_CALL = JSON.stringify({
  jsonrpc: '2.0',
  id: 1,
  method: 'tools/call',
  params: { name: 'get_order_status', arguments: {} },
});
const MCP_HEADERS = {
  'content-type': 'application/json',
  accept: 'application/json, text/event-stream',
};
const ACT = { externalUserId: 'member-1', channel: 'api', conversationId: 'conv-1' };

const closers = [];
afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()));
});

/** The example app on a free port, wired to a fake core-api (JWKS + embed sessions). */
async function start({ env = {}, e2e = true } = {}) {
  const signer = await createOwnSigner(ISSUER, ORG_ID);
  const coreApiCalls = [];
  const craftedai = new CraftedAI({
    apiOrigin: ISSUER,
    orgId: ORG_ID,
    appSecret: APP_SECRET,
    secretKey: SECRET_KEY,
    env,
    fetch: async (input, init) => {
      const url = String(input);
      if (url.endsWith('/embed-sessions')) {
        coreApiCalls.push({ method: init?.method, headers: init?.headers, body: init?.body });
        if (init?.method === 'DELETE') return new Response(null, { status: 204 });
        return Response.json(
          {
            embedSession: {
              token: `cais_${'s'.repeat(43)}`,
              expiresAt: '2026-09-21T19:15:00.000Z',
              refreshBeforeSeconds: 60,
              frameUrl: 'https://chat.craftedai.co/embed',
              frameOrigin: 'https://chat.craftedai.co',
            },
            branding: { displayName: 'Support' },
          },
          { status: 201 },
        );
      }
      return signer.fetch(input, init);
    },
  });
  const app = createApp({ craftedai, agentId: AGENT_ID, e2e });
  const server = await new Promise((resolve) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  closers.push(() => new Promise((resolve) => server.close(resolve)));
  const origin = `http://127.0.0.1:${server.address().port}`;
  return { origin, craftedai, coreApiCalls, signer };
}

const nowSeconds = () => Math.floor(Date.now() / 1000);

async function signedHeaders(signer, aud, { delegatedUser = 'member-1' } = {}) {
  const headers = {
    ...MCP_HEADERS,
    'x-craftedai-request': await signer.sign({
      aud,
      body: TOOL_CALL,
      nowSeconds: nowSeconds(),
      act: ACT,
    }),
  };
  if (delegatedUser !== null) {
    const { token } = await mintDelegationToken({
      appSecret: APP_SECRET,
      orgId: ORG_ID,
      externalUserId: delegatedUser,
      nowSeconds: nowSeconds(),
    });
    headers['x-craftedai-actor-delegation'] = token;
  }
  return headers;
}

/** The JSON-RPC message inside the Streamable HTTP event stream. */
const rpcMessage = (text) => JSON.parse(/^data: (.*)$/m.exec(text)[1]);

describe('POST /mcp', () => {
  it('lets a signed request with a delegation reach the MCP tool', async () => {
    const { origin, signer } = await start();
    const response = await fetch(`${origin}/mcp`, {
      method: 'POST',
      headers: await signedHeaders(signer, `${origin}/mcp`),
      body: TOOL_CALL,
    });
    expect(response.status).toBe(200);
    const result = rpcMessage(await response.text()).result;
    expect(JSON.parse(result.content[0].text)).toEqual({ id: 'ord_1001', status: 'shipped' });

    // The handler saw the verified context, not anything the caller typed.
    const seen = await (await fetch(`${origin}/__e2e/mcp-calls`)).json();
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      method: 'tools/call',
      orgId: ORG_ID,
      user: 'member-1',
      delegated: true,
    });
  });

  it('answers 401 to an unsigned request and never reaches the handler', async () => {
    const { origin } = await start();
    const response = await fetch(`${origin}/mcp`, {
      method: 'POST',
      headers: MCP_HEADERS,
      body: TOOL_CALL,
    });
    expect(response.status).toBe(401);
    expect((await response.json()).error).toBe('craftedai_verification_failed');
    expect(await (await fetch(`${origin}/__e2e/mcp-calls`)).json()).toEqual([]);
  });

  it('answers 401 delegation_missing when the web app did not vouch for the user', async () => {
    const { origin, signer } = await start();
    const response = await fetch(`${origin}/mcp`, {
      method: 'POST',
      headers: await signedHeaders(signer, `${origin}/mcp`, { delegatedUser: null }),
      body: TOOL_CALL,
    });
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ reason: 'delegation_missing' });
  });

  it('answers 401 wrong_audience for a token minted for another URL', async () => {
    const { origin, signer } = await start();
    const response = await fetch(`${origin}/mcp`, {
      method: 'POST',
      headers: await signedHeaders(signer, 'https://elsewhere.example/mcp'),
      body: TOOL_CALL,
    });
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ reason: 'wrong_audience' });
  });

  it('takes publicUrl from CRAFTEDAI_PUBLIC_URL, for a server behind a proxy', async () => {
    const registered = 'https://shop.example/mcp';
    const { origin, signer } = await start({ env: { CRAFTEDAI_PUBLIC_URL: registered } });
    const response = await fetch(`${origin}/mcp`, {
      method: 'POST',
      headers: await signedHeaders(signer, registered),
      body: TOOL_CALL,
    });
    expect(response.status).toBe(200);
  });

  it('hides the e2e route unless it is switched on', async () => {
    const { origin } = await start({ e2e: false });
    expect((await fetch(`${origin}/__e2e/mcp-calls`)).status).toBe(404);
  });
});

describe('the web app', () => {
  async function loggedIn(origin) {
    const login = await fetch(`${origin}/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'user=member-1',
      redirect: 'manual',
    });
    return login.headers.get('set-cookie').split(';')[0];
  }

  it('serves the page with the widget tag and the CSP from cspDirectiveString()', async () => {
    const chatOrigin = 'https://chat.staging.craftedai.test';
    const { origin, craftedai } = await start({ env: { CRAFTEDAI_CHAT_ORIGIN: chatOrigin } });
    const response = await fetch(`${origin}/`);
    expect(response.headers.get('content-security-policy')).toBe(
      `default-src 'self'; ${craftedai.cspDirectiveString()}`,
    );
    expect(response.headers.get('content-security-policy')).toContain(
      `script-src ${chatOrigin}; frame-src ${chatOrigin};`,
    );
    const html = await response.text();
    expect(html).toContain(`<script src="${chatOrigin}/widget.js"`);
    expect(html).toContain(`data-agent="${AGENT_ID}"`);
    expect(html).toContain('data-session-endpoint="/craftedai/session"');
  });

  it('mints a session from the JSON body for a signed-in user', async () => {
    const { origin, coreApiCalls } = await start();
    const cookie = await loggedIn(origin);
    const response = await fetch(`${origin}/craftedai/session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin, cookie },
      body: JSON.stringify({ agentId: AGENT_ID }),
    });
    expect(response.status).toBe(200);
    expect((await response.json()).token).toMatch(/^cais_/);
    expect(coreApiCalls).toHaveLength(1);
    expect(coreApiCalls[0].headers['x-external-user-id']).toBe('member-1');
    expect(JSON.parse(coreApiCalls[0].body)).toMatchObject({
      agentId: AGENT_ID,
      hostOrigin: origin,
    });
  });

  it('answers 401 to the session route when nobody is signed in', async () => {
    const { origin, coreApiCalls } = await start();
    const response = await fetch(`${origin}/craftedai/session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin },
      body: JSON.stringify({ agentId: AGENT_ID }),
    });
    expect(response.status).toBe(401);
    expect(coreApiCalls).toEqual([]);
  });

  it('revokes the widget session on logout', async () => {
    const { origin, coreApiCalls } = await start();
    const cookie = await loggedIn(origin);
    const response = await fetch(`${origin}/logout`, {
      method: 'POST',
      headers: { cookie },
      redirect: 'manual',
    });
    expect(response.status).toBe(302);
    expect(coreApiCalls.map((call) => call.method)).toEqual(['DELETE']);
    expect(coreApiCalls[0].headers['x-external-user-id']).toBe('member-1');
  });
});

describe('server.js', () => {
  it('boots from the environment alone and serves the page', async () => {
    const port = await new Promise((resolve) => {
      const probe = createServer().listen(0, '127.0.0.1', () => {
        const { port: free } = probe.address();
        probe.close(() => resolve(free));
      });
    });
    const child = spawn(process.execPath, ['server.js'], {
      cwd: dirname(fileURLToPath(import.meta.url)),
      env: {
        ...process.env,
        PORT: String(port),
        CRAFTEDAI_SECRET_KEY: SECRET_KEY,
        CRAFTEDAI_APP_SECRET: APP_SECRET,
        CRAFTEDAI_ORG_ID: ORG_ID,
        CRAFTEDAI_AGENT_ID: AGENT_ID,
      },
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    closers.push(
      () =>
        new Promise((resolve) => {
          child.once('exit', resolve);
          child.kill();
        }),
    );
    await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (code) => reject(new Error(`server.js exited early (${code})`)));
      child.stdout.on('data', (chunk) => {
        if (String(chunk).includes('listening')) resolve();
      });
    });
    const response = await fetch(`http://127.0.0.1:${port}/`);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain(`data-agent="${AGENT_ID}"`);
  });
});
