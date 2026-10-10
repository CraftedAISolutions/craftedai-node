import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';

/** core-api started by `e2e/start-core-api.sh` (host network): API on :3000. */
export const API = process.env.E2E_CORE_API_ORIGIN ?? 'http://localhost:3000';
const CORE_API_DIR = process.env.E2E_CORE_API_DIR ?? '../core-api';
const COMPOSE = [
  'compose',
  '-f',
  'docker-compose.yml',
  '-f',
  `${process.cwd()}/e2e/docker-compose.e2e.yml`,
];

export const MOCK_PROVIDER_PORT = 9999;
export const EXAMPLE_PORT = 4000;
export const EXAMPLE_ORIGIN = `http://localhost:${EXAMPLE_PORT}`;

/**
 * Runs a command inside the core-api stack. CI (Linux) uses `docker compose exec`.
 * `E2E_CORE_API_NATIVE=1` is for a developer machine where core-api runs on the host
 * (`npm run dev` from the checkout, DATABASE_URL etc. in this process's environment):
 * scripts then run in the checkout, and the one SQL statement goes through its `pg`.
 */
function exec(service: 'api' | 'postgres', args: string[]): string {
  const native = process.env.E2E_CORE_API_NATIVE === '1';
  const [file, fileArgs]: [string, string[]] = native
    ? service === 'api'
      ? [args[0] ?? '', args.slice(1)]
      : ['node', ['-e', NATIVE_SQL, args.at(-1) ?? '']]
    : ['docker', [...COMPOSE, 'exec', '-T', service, ...args]];
  try {
    return execFileSync(file, fileArgs, { cwd: CORE_API_DIR, encoding: 'utf8' });
  } catch (error) {
    // execFileSync quotes the whole command line, passwords included: say only what failed.
    const status = (error as { status?: number | null }).status;
    // eslint-disable-next-line preserve-caught-error -- the original error quotes the command line
    throw new Error(`${service} command failed (exit ${String(status)}): ${args[0] ?? ''} …`);
  }
}

const NATIVE_SQL = `
const { Client } = require('pg');
const c = new Client({ connectionString: process.env.DATABASE_URL });
c.connect().then(() => c.query(process.argv[1])).then(() => c.end());
`;

async function call<T>(
  method: string,
  path: string,
  init: { token?: string; orgId?: string; body?: unknown; expect?: number } = {},
): Promise<T> {
  const response = await fetch(`${API}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(init.token ? { authorization: `Bearer ${init.token}` } : {}),
      ...(init.orgId ? { 'x-org-id': init.orgId } : {}),
    },
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
  });
  const text = await response.text();
  if (response.status !== (init.expect ?? response.status) || response.status >= 400) {
    throw new Error(`${method} ${path} → ${response.status} ${text.slice(0, 300)}`);
  }
  return (text === '' ? undefined : JSON.parse(text)) as T;
}

export interface Seeded {
  orgId: string;
  agentId: string;
  integrationId: string;
  serverKey: string;
  auth: { token: string; orgId: string };
}

/**
 * Phase 1 — the customer's CraftedAI side, through core-api's own API, the way
 * "Connect your app" does it: founder (script) → verified → model (mock
 * provider) → jwt MCP integration → agent → server key. The MCP is not
 * called yet: the example app needs the `.env` that init writes from this key.
 */
export async function seedAgent(): Promise<Seeded> {
  const email = `e2e-${Date.now()}@craftedai.test`;
  // Generated per run, never printed (core-api wants 12+ chars with a letter and a digit).
  const password = `e2e-${randomBytes(16).toString('hex')}`;
  const founder = JSON.parse(
    exec('api', [
      'npm',
      'run',
      '-s',
      'create-founder',
      '--',
      '--email',
      email,
      '--password',
      password,
    ]),
  ) as { user: { id: string }; organization: { id: string } };
  exec('postgres', [
    'psql',
    '-U',
    'craftedai',
    '-d',
    'craftedai',
    '-c',
    `UPDATE users SET "emailVerifiedAt" = now() WHERE id = '${founder.user.id}'`,
  ]);
  const { accessToken } = await call<{ accessToken: string }>('POST', '/auth/login', {
    body: { email, password },
  });
  const orgId = founder.organization.id;
  const auth = { token: accessToken, orgId };

  // GET /models answers the catalog as a bare array.
  const models = await call<{ id: string; provider: string }[]>('GET', '/models', auth);
  const model = models.find((m) => m.provider === 'openai');
  if (model === undefined) throw new Error('no openai model in the catalog (npm run seed:catalog)');
  await call('POST', '/organization-models', {
    ...auth,
    body: {
      modelId: model.id,
      apiKey: 'sk-e2e-mock-provider-key',
      baseUrl: `http://localhost:${MOCK_PROVIDER_PORT}/v1`,
    },
  });

  const integration = await call<{ id: string; signingMode: string }>(
    'POST',
    `/organizations/${orgId}/integrations`,
    {
      ...auth,
      body: {
        kind: 'mcp',
        slug: 'example-shop',
        displayName: 'Example shop',
        config: { endpoint: `${EXAMPLE_ORIGIN}/mcp`, transport: 'streamable-http' },
        requiresDelegation: true,
      },
    },
  );
  if (integration.signingMode !== 'jwt')
    throw new Error(`integration is ${integration.signingMode}`);

  const bot = await call<{ id: string }>('POST', '/bots', {
    ...auth,
    body: {
      slug: 'e2e-support',
      displayName: 'E2E Support',
      modelSlug: model.id,
      systemPrompt: 'Use get_order_status to answer order questions.',
      allowedPluginIds: [integration.id],
    },
  });
  const key = await call<{ data: { credential: { plaintextKey: string } } }>(
    'POST',
    `/organizations/${orgId}/bots/${bot.id}/server-key`,
    auth,
  );
  return {
    orgId,
    agentId: bot.id,
    integrationId: integration.id,
    serverKey: key.data.credential.plaintextKey,
    auth,
  };
}

/** Phase 2 — with the example MCP running: signed tools/list (catalog), publish, enable embed. */
export async function goLive(seeded: Seeded): Promise<void> {
  const { auth, orgId, integrationId, agentId } = seeded;
  // Creating the integration already queued a "register" refresh that failed (the example
  // MCP was not up yet) and retries with backoff; a manual refresh inside the first 10s is
  // a 409 debounce. Either path stamps `catalogRefreshedAt`, and publishing before that is a
  // 409 `mcp_catalog_not_ready`: ask for a refresh until one is accepted, and wait for the stamp.
  const integrationPath = `/organizations/${orgId}/integrations/${integrationId}`;
  let refreshRequested = false;
  for (let attempt = 0; ; attempt += 1) {
    const row = await call<{ catalogRefreshedAt: string | null }>('GET', integrationPath, auth);
    if (row.catalogRefreshedAt !== null) break;
    if (attempt >= 80) throw new Error('the integration catalog was not refreshed in 40s');
    if (!refreshRequested) {
      const refresh = await fetch(`${API}${integrationPath}/refresh`, {
        method: 'POST',
        headers: { authorization: `Bearer ${auth.token}`, 'x-org-id': orgId },
      });
      refreshRequested = refresh.status === 202;
      if (!refreshRequested && refresh.status !== 409) {
        throw new Error(`refresh → ${refresh.status} ${(await refresh.text()).slice(0, 300)}`);
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  await call('PUT', `/control-plane/v1/bots/${agentId}/publication`, auth);
  await call('PUT', `/control-plane/v1/bots/${agentId}/embed-config`, {
    ...auth,
    body: { embedEnabled: true, allowedOrigins: [EXAMPLE_ORIGIN], writeToolDailyLimit: null },
  });
}

/** What the widget does with a session: boot, open a conversation, run one turn (SSE). */
export async function widgetTurn(
  sessionToken: string,
  agentId: string,
  content: string,
): Promise<{ type: string; [key: string]: unknown }[]> {
  const headers = {
    authorization: `Bearer ${sessionToken}`,
    'x-craftedai-ancestor-origin': EXAMPLE_ORIGIN,
    'content-type': 'application/json',
  };
  const conversation = await fetch(`${API}/portal/v1/conversations`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ agentId }),
  });
  if (conversation.status !== 201) throw new Error(`conversation → ${conversation.status}`);
  const { id } = (await conversation.json()) as { id: string };
  const turn = await fetch(`${API}/portal/v1/conversations/${id}/turns`, {
    method: 'POST',
    headers: {
      ...headers,
      accept: 'text/event-stream',
      'idempotency-key': `e2e-${Date.now()}-turn-one`,
    },
    body: JSON.stringify({ content }),
  });
  if (turn.status !== 200) throw new Error(`turn → ${turn.status} ${await turn.text()}`);
  const events: { type: string }[] = [];
  for (const line of (await turn.text()).split('\n')) {
    if (line.startsWith('data: ')) events.push(JSON.parse(line.slice(6)) as { type: string });
  }
  return events;
}

export async function sessionIsLive(sessionToken: string): Promise<number> {
  const response = await fetch(`${API}/portal/v1/embed-sessions/current`, {
    headers: {
      authorization: `Bearer ${sessionToken}`,
      'x-craftedai-ancestor-origin': EXAMPLE_ORIGIN,
    },
  });
  return response.status;
}
