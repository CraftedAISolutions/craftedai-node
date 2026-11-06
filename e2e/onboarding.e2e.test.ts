import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { cpSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  API,
  currentSession,
  EXAMPLE_ORIGIN,
  EXAMPLE_PORT,
  goLive,
  MOCK_PROVIDER_PORT,
  openConversationStatus,
  seedAgent,
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
let appDir = '';

async function waitFor(url: string, child: ChildProcess): Promise<void> {
  for (let i = 0; i < 50; i += 1) {
    // A port already taken (or a crash on boot) must read as that, not as a 10s wait.
    if (child.exitCode !== null) throw new Error(`the example exited with code ${child.exitCode}`);
    try {
      // Only the example answers this route (e2e mode): another process on the port would 404.
      if ((await fetch(url)).ok) return;
    } catch {
      // not listening yet
    }
    await new Promise((r) => setTimeout(r, 200));
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
  // rmSync unlinks the node_modules symlink; it never follows it into the checkout.
  if (appDir !== '') rmSync(appDir, { recursive: true, force: true });
});

interface McpCall {
  method: string;
  user: string | null;
  delegated: boolean;
  orgId: string;
}

/** What the example's MCP recorded: method plus the verified context (see examples/express). */
async function mcpCalls(): Promise<McpCall[]> {
  return (await (await fetch(`${EXAMPLE_ORIGIN}/__e2e/mcp-calls`)).json()) as McpCall[];
}

describe('onboarding end to end (spec §11)', () => {
  it('1. init writes .env from the server key, never overwriting', () => {
    writeFileSync(join(appDir, '.env'), 'PORT=4000\n');
    const run = (): string => {
      try {
        return execFileSync('node', [join(ROOT, 'dist/cli.js'), 'init', '--api-origin', API], {
          cwd: appDir,
          env: { ...process.env, CRAFTEDAI_SECRET_KEY: seeded.serverKey },
          encoding: 'utf8',
        });
      } catch (error) {
        // The thrown error carries the process environment and output: say only what failed.
        // eslint-disable-next-line preserve-caught-error -- the cause would print them
        throw new Error(
          `craftedai init failed (exit ${String((error as { status?: number }).status)})`,
        );
      }
    };
    // Assertions below are on booleans: a failure must never print .env or the init output,
    // which hold the app secret.
    const first = run();
    expect(first.includes(`data-agent="${seeded.agentId}"`), 'init prints the agent id').toBe(true);
    const env = readFileSync(join(appDir, '.env'), 'utf8');
    expect(env.includes(`CRAFTEDAI_ORG_ID=${seeded.orgId}`), 'org id written').toBe(true);
    expect(/CRAFTEDAI_APP_SECRET=[A-Za-z0-9_-]{43}\n/.test(env), 'app secret written').toBe(true);
    expect(run().includes('skipped CRAFTEDAI_APP_SECRET'), 'second run skips the secret').toBe(
      true,
    );
    expect(readFileSync(join(appDir, '.env'), 'utf8') === env, '.env untouched on rerun').toBe(
      true,
    );
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
    await waitFor(`${EXAMPLE_ORIGIN}/__e2e/mcp-calls`, example);
    await goLive(seeded);
    const calls = await mcpCalls();
    expect(calls.some((c) => c.method === 'tools/list')).toBe(true);

    // Negative control: the guard is what lets the signed calls through, not an open door.
    const before = calls.length;
    const unsigned = await fetch(`${EXAMPLE_ORIGIN}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    expect(unsigned.status).toBe(401);
    expect((await mcpCalls()).length).toBe(before);
  }, 90_000);

  let sessionToken = '';
  let cookie = '';

  it('3. a signed-in user mints a session through the example session route, pinned to the agent', async () => {
    const login = await fetch(`${EXAMPLE_ORIGIN}/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'user=member-1',
      redirect: 'manual',
    });
    cookie = (login.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
    const mint = (agentId: string) =>
      fetch(`${EXAMPLE_ORIGIN}/craftedai/session`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: EXAMPLE_ORIGIN, cookie },
        body: JSON.stringify({ agentId }),
      });

    // SDK pin: the route mints for the configured agent only.
    expect((await mint(randomUUID())).status).toBe(403);
    expect((await mint(seeded.otherAgentId)).status).toBe(403); // live, same org, still refused

    const session = await mint(seeded.agentId);
    expect(session.status).toBe(200);
    const boot = (await session.json()) as { token: string; refreshBeforeSeconds: number };
    expect(boot.token).toMatch(/^cais_/);
    sessionToken = boot.token;
    // core-api agrees on who the session is for.
    expect(await currentSession(sessionToken)).toEqual({ status: 200, agentId: seeded.agentId });
  });

  it('4. a widget turn calls the MCP tool with a verified, delegated user', async () => {
    // core-api pin: another live agent of the same org is out of reach for this session.
    const refused = await openConversationStatus(sessionToken, seeded.otherAgentId);
    expect(refused).toBe(404); // agent_unavailable: the session's agent is the only one in reach

    const events = await widgetTurn(sessionToken, seeded.agentId, 'Where is my order?');
    // Read-only tool calls emit no `tool.*` portal events (those are the confirmation path):
    // the proof is the tool result in the answer, and what the MCP verified (below).
    const answer = events.map((e) => (e.type === 'text.delta' ? String(e.delta) : '')).join('');
    expect(answer).toContain('ord_1001');
    expect(events.at(-1)?.type).toBe('turn.completed');
    expect((await mcpCalls()).find((c) => c.method === 'tools/call')).toMatchObject({
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
    expect((await currentSession(sessionToken)).status).toBe(401);
  });
});
