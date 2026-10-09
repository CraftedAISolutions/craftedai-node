import { cspDirectives, formatCspDirectives } from '../csp.js';

/** Which server framework a project uses, from its package.json dependencies. First match wins. */
export const FRAMEWORKS = [
  'next',
  'react-router',
  'remix',
  'hono',
  'fastify',
  'express',
  'node',
] as const;
export type Framework = (typeof FRAMEWORKS)[number];

type Dependencies = Record<string, unknown>;

function dependenciesOf(packageJson: unknown): Dependencies {
  if (typeof packageJson !== 'object' || packageJson === null) return {};
  const { dependencies, devDependencies } = packageJson as Record<string, unknown>;
  const own = (value: unknown): Dependencies =>
    typeof value === 'object' && value !== null ? (value as Dependencies) : {};
  return { ...own(dependencies), ...own(devDependencies) };
}

export function detectFramework(packageJson: unknown): Framework {
  const deps = dependenciesOf(packageJson);
  const has = (name: string) => Object.hasOwn(deps, name);
  if (has('next')) return 'next';
  if (has('react-router') || has('@react-router/node')) return 'react-router';
  if (Object.keys(deps).some((name) => name.startsWith('@remix-run/'))) return 'remix';
  if (has('hono')) return 'hono';
  if (has('fastify')) return 'fastify';
  if (has('express')) return 'express';
  return 'node';
}

const SESSION_PATH = '/craftedai/session';

const PUBLIC_URL_NOTE =
  '// publicUrl: the MCP URL exactly as registered in CraftedAI. Set it (or CRAFTEDAI_PUBLIC_URL) behind\n' +
  '// a proxy or load balancer, where this server sees an internal URL instead.';

const CSP_NOTE =
  '// CSP: merge craftedai.cspDirectiveString() into your Content-Security-Policy (the widget needs it).';

const FETCH_NOTES = `${PUBLIC_URL_NOTE}
// Mount the guard before anything reads the request body: pass it the untouched Request.
${CSP_NOTE}`;

/** The session route + MCP guard snippet printed after init. The guard always goes before body parsers. */
export function routeSnippet(framework: Framework): string {
  switch (framework) {
    case 'express':
      return `import express from 'express';
import { CraftedAI } from '@craftedai/node';
const craftedai = new CraftedAI(); // reads the CRAFTEDAI_* variables

const app = express();

// MCP server: mount the guard BEFORE express.json() or any other body parser.
// On success req.craftedai = { orgId, user, delegated }.
app.post('/mcp', craftedai.express.verifyRequest({ publicUrl: 'https://your-host.example/mcp' }), mcpHandler);
${PUBLIC_URL_NOTE}

app.use(express.json());

// Web app: the widget's session route (your auth middleware runs first).
app.post('${SESSION_PATH}', craftedai.express.sessionHandler({ getUser: (req) => req.user?.id }));
// On logout: await craftedai.revokeSessions(userId);

${CSP_NOTE}`;
    case 'fastify':
      return `import { CraftedAI } from '@craftedai/node';
const craftedai = new CraftedAI(); // reads the CRAFTEDAI_* variables

// Web app: the widget's session route (your auth hook runs first).
app.post('${SESSION_PATH}', craftedai.fastify.sessionHandler({ getUser: (request) => request.user?.id }));
// On logout: await craftedai.revokeSessions(userId);

// MCP server: protect an encapsulated scope. It replaces that scope's body parsers with one that
// keeps the exact bytes, so the guard sees the body before any parser of yours. Never call protect()
// on the root instance.
await app.register(async (mcp) => {
  craftedai.fastify.protect(mcp, { publicUrl: 'https://your-host.example/mcp' });
  mcp.post('/mcp', async (request, reply) => {
    const context = craftedai.fastify.context(request); // { orgId, user, delegated }
    return mcpHandler(request, reply, context);
  });
});
${PUBLIC_URL_NOTE}
${CSP_NOTE}`;
    case 'next':
      return `// app${SESSION_PATH}/route.ts
import { CraftedAI } from '@craftedai/node';
const craftedai = new CraftedAI(); // reads the CRAFTEDAI_* variables
export const POST = craftedai.fetch.sessionHandler({
  getUser: async (request) => (await getSession(request))?.userId,
});
// On logout: await craftedai.revokeSessions(userId);

// app/mcp/route.ts (only if this app also serves your MCP endpoint)
export const POST = craftedai.fetch.verifyRequest(
  (request, context) => mcpHandler(request, context), // context = { orgId, user, delegated }
  { publicUrl: 'https://your-host.example/mcp' },
);
${FETCH_NOTES}
// In next.config.js headers(): { key: 'Content-Security-Policy', value: <your policy + craftedai.cspDirectiveString()> }`;
    case 'react-router':
    case 'remix':
      return `import { CraftedAI } from '@craftedai/node';
const craftedai = new CraftedAI(); // reads the CRAFTEDAI_* variables

const sessionRoute = craftedai.fetch.sessionHandler({
  getUser: async (request) => (await getSession(request))?.userId,
});
const mcpRoute = craftedai.fetch.verifyRequest(
  (request, context) => mcpHandler(request, context), // context = { orgId, user, delegated }
  { publicUrl: 'https://your-host.example/mcp' },
);

// app/routes/craftedai.session.ts  (POST ${SESSION_PATH})
export const action = ({ request }) => sessionRoute(request);
// app/routes/mcp.ts  (POST /mcp, only if this app also serves your MCP endpoint)
export const action = ({ request }) => mcpRoute(request);
${FETCH_NOTES}`;
    case 'hono':
      return `import { CraftedAI } from '@craftedai/node';
const craftedai = new CraftedAI(); // reads the CRAFTEDAI_* variables

const sessionRoute = craftedai.fetch.sessionHandler({
  getUser: async (request) => (await getSession(request))?.userId,
});
const mcpRoute = craftedai.fetch.verifyRequest(
  (request, context) => mcpHandler(request, context), // context = { orgId, user, delegated }
  { publicUrl: 'https://your-host.example/mcp' },
);

app.post('${SESSION_PATH}', (c) => sessionRoute(c.req.raw));
app.post('/mcp', (c) => mcpRoute(c.req.raw)); // only if this app also serves your MCP endpoint
${FETCH_NOTES}`;
    case 'node':
      return `import { CraftedAI } from '@craftedai/node';
const craftedai = new CraftedAI(); // reads the CRAFTEDAI_* variables

// Any runtime that hands you a web-standard (Request) => Response, such as Bun, Deno or Workers:
const sessionRoute = craftedai.fetch.sessionHandler({
  getUser: async (request) => (await getSession(request))?.userId,
});
const mcpRoute = craftedai.fetch.verifyRequest(
  (request, context) => mcpHandler(request, context), // context = { orgId, user, delegated }
  { publicUrl: 'https://your-host.example/mcp' },
);
// Mount sessionRoute at POST ${SESSION_PATH} and mcpRoute at POST /mcp.
// On a plain node:http server, use Express or Fastify (or convert req to a Request) instead.
${FETCH_NOTES}`;
  }
}

export function widgetSnippet(chatOrigin: string, agentId: string): string {
  return `<script src="${chatOrigin}/widget.js" data-agent="${agentId}"
        data-session-endpoint="${SESSION_PATH}" async></script>`;
}

/** The CSP the widget needs, written with the library's own formatter. */
export function cspSnippet(chatOrigin: string): string {
  return `Content-Security-Policy additions: ${formatCspDirectives(cspDirectives(chatOrigin))}`;
}
