import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  API,
  EXAMPLE_ORIGIN,
  EXAMPLE_PORT,
  goLive,
  MOCK_PROVIDER_PORT,
  seedAgent,
  sessionIsLive,
  widgetTurn,
  type Seeded,
} from './core-api.js';
import { startMockProvider } from './mock-provider.js';

/**
 * Spec §11: example Express app (web + MCP) against a local core-api in
 * Docker — init → mint → tool call with delegation → logout revoke.
 * Needs `e2e/start-core-api.sh` first (CI job `e2e`).
 */
const ROOT = process.cwd();
let provider: Server;
let example: ChildProcess;
let seeded: Seeded;
let appDir: string;

async function waitFor(url: string): Promise<void> {
  for (let i = 0; i < 50; i += 1) {
    try {
      await fetch(url);
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  throw new Error(`${url} did not come up`);
}

beforeAll(async () => {
  provider = await startMockProvider(MOCK_PROVIDER_PORT);
  seeded = await seedAgent();
  appDir = mkdtempSync(join(tmpdir(), 'craftedai-e2e-'));
  // The example's own unit test imports relative to the repo, and its node_modules holds a
  // relative symlink to this checkout: copy the sources only and link the installed modules.
  cpSync(join(ROOT, 'examples/express'), appDir, {
    recursive: true,
    filter: (source) => !['node_modules', 'app.test.js'].includes(basename(source)),
  });
  symlinkSync(join(ROOT, 'examples/express/node_modules'), join(appDir, 'node_modules'), 'dir');
}, 120_000);

afterAll(() => {
  example?.kill();
  provider?.close();
});

describe('onboarding end to end (spec §11)', () => {
  it('1. init writes .env from the server key, never overwriting', () => {
    writeFileSync(join(appDir, '.env'), 'PORT=4000\n');
    const run = () =>
      execFileSync('node', [join(ROOT, 'dist/cli.js'), 'init', '--api-origin', API], {
        cwd: appDir,
        env: { ...process.env, CRAFTEDAI_SECRET_KEY: seeded.serverKey },
        encoding: 'utf8',
      });
    const first = run();
    expect(first).toContain(`data-agent="${seeded.agentId}"`);
    const env = readFileSync(join(appDir, '.env'), 'utf8');
    expect(env).toContain(`CRAFTEDAI_ORG_ID=${seeded.orgId}`);
    expect(env).toMatch(/CRAFTEDAI_APP_SECRET=[A-Za-z0-9_-]{43}\n/);
    expect(run()).toContain('skipped CRAFTEDAI_APP_SECRET');
    expect(readFileSync(join(appDir, '.env'), 'utf8')).toBe(env);
  });

  it('2. the signed tools/list from core-api passes the example guard; the agent goes live', async () => {
    example = spawn('node', ['--env-file=.env', 'server.js'], {
      cwd: appDir,
      env: {
        ...process.env,
        PORT: String(EXAMPLE_PORT),
        EXAMPLE_E2E: '1',
        CRAFTEDAI_API_ORIGIN: API,
        CRAFTEDAI_CHAT_ORIGIN: 'http://localhost:5174',
        CRAFTEDAI_AGENT_ID: seeded.agentId,
      },
      stdio: 'inherit',
    });
    await waitFor(`${EXAMPLE_ORIGIN}/`);
    await goLive(seeded);
    const calls = (await (await fetch(`${EXAMPLE_ORIGIN}/__e2e/mcp-calls`)).json()) as {
      method: string;
    }[];
    expect(calls.some((c) => c.method === 'tools/list')).toBe(true);
  }, 60_000);

  let sessionToken = '';
  let cookie = '';

  it('3. a signed-in user mints a session through the example session route', async () => {
    const login = await fetch(`${EXAMPLE_ORIGIN}/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'user=member-1',
      redirect: 'manual',
    });
    cookie = (login.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
    const session = await fetch(`${EXAMPLE_ORIGIN}/craftedai/session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: EXAMPLE_ORIGIN, cookie },
      body: JSON.stringify({ agentId: seeded.agentId }),
    });
    expect(session.status).toBe(200);
    const boot = (await session.json()) as { token: string; refreshBeforeSeconds: number };
    expect(boot.token).toMatch(/^cais_/);
    sessionToken = boot.token;
    expect(await sessionIsLive(sessionToken)).toBe(200);
  });

  it('4. a widget turn calls the MCP tool with a verified, delegated user', async () => {
    const events = await widgetTurn(sessionToken, seeded.agentId, 'Where is my order?');
    // Read-only tool calls emit no `tool.*` portal events (those are the confirmation path):
    // the proof is the tool result in the answer, and what the MCP verified (below).
    const answer = events.map((e) => (e.type === 'text.delta' ? String(e.delta) : '')).join('');
    expect(answer).toContain('ord_1001');
    expect(events.at(-1)?.type).toBe('turn.completed');
    const calls = (await (await fetch(`${EXAMPLE_ORIGIN}/__e2e/mcp-calls`)).json()) as {
      method: string;
      user: string | null;
      delegated: boolean;
      orgId: string;
    }[];
    expect(calls.find((c) => c.method === 'tools/call')).toMatchObject({
      user: 'member-1',
      delegated: true,
      orgId: seeded.orgId,
    });
  }, 60_000);

  it('5. logout revokes the widget session', async () => {
    await fetch(`${EXAMPLE_ORIGIN}/logout`, {
      method: 'POST',
      headers: { cookie },
      redirect: 'manual',
    });
    expect(await sessionIsLive(sessionToken)).toBe(401);
  });
});
