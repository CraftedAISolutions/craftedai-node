// Example: one Express app that is both the customer's web app and their MCP server.
import { randomUUID } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import express from 'express';

// Anything a visitor can type and the page prints goes through this first.
const escapeHtml = (text) =>
  String(text).replace(
    /[&<>"']/g,
    (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char],
  );

// A toy order database. Replace with yours.
const ORDERS = { 'member-1': { id: 'ord_1001', status: 'shipped' } };

/**
 * @param {object} options
 * @param {import('@craftedai/node').CraftedAI} options.craftedai
 * @param {string} [options.agentId] the agent the widget talks to; when set, the session route
 *   mints for this agent only
 * @param {boolean} [options.e2e] expose GET /__e2e/mcp-calls (the verified contexts the MCP saw)
 */
export function createApp({ craftedai, agentId, e2e = false }) {
  const app = express();

  // ------------------------------------------------------------ toy auth (replace with yours)
  // A signed-in user is a `demo_sid` cookie. Never do this in production.
  const sessions = new Map(); // sessionId -> userId
  const currentUser = (req) => {
    const sid = /(?:^|;\s*)demo_sid=([^;]+)/.exec(req.headers.cookie ?? '')?.[1];
    return sid ? sessions.get(sid) : undefined;
  };

  // ------------------------------------------------------------ MCP: guard BEFORE any body parser
  // The guard reads the raw request body to check it was signed, so nothing may consume the
  // stream first: no app.use(express.json()) above this route (or anywhere that reaches it).
  const mcpCalls = []; // test seam, exposed only when `e2e` is set

  const buildMcpServer = (context) => {
    const server = new McpServer({ name: 'example-shop', version: '1.0.0' });
    server.registerTool(
      'get_order_status',
      {
        description: "Get the signed-in member's latest order status.",
        inputSchema: {},
        annotations: { readOnlyHint: true },
      },
      () => {
        // The user comes from the verified request token; the delegation proves your own web
        // app vouched for this user in the last 5 minutes (spec §5.3).
        if (!context.user || !context.delegated) {
          return { isError: true, content: [{ type: 'text', text: 'No signed-in member.' }] };
        }
        const order = ORDERS[context.user] ?? null;
        return { content: [{ type: 'text', text: JSON.stringify(order) }] };
      },
    );
    return server;
  };

  // Behind a proxy, set CRAFTEDAI_PUBLIC_URL (see .env.example); locally the guard needs no option.
  app.post('/mcp', craftedai.express.verifyRequest(), async (req, res, next) => {
    try {
      mcpCalls.push({ method: req.body?.method, ...req.craftedai });
      // Stateless: one server + transport per request.
      const server = buildMcpServer(req.craftedai);
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      res.on('close', () => {
        void transport.close();
        void server.close();
      });
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      next(error);
    }
  });

  if (e2e) app.get('/__e2e/mcp-calls', (_req, res) => res.json(mcpCalls));

  // ------------------------------------------------------------ web: login, page, CSP, session route
  app.post('/login', express.urlencoded({ extended: false }), (req, res) => {
    const sid = randomUUID();
    sessions.set(sid, String(req.body?.user ?? 'member-1'));
    res.setHeader('set-cookie', `demo_sid=${sid}; HttpOnly; SameSite=Lax; Path=/`).redirect('/');
  });

  app.post('/logout', async (req, res, next) => {
    try {
      const userId = currentUser(req);
      if (userId) await craftedai.revokeSessions(userId); // spec §4.2: kill the widget session on logout
      res.setHeader('set-cookie', 'demo_sid=; Max-Age=0; Path=/').redirect('/');
    } catch (error) {
      next(error);
    }
  });

  app.get('/', (req, res) => {
    // The two directives the widget needs, merged into this page's own policy.
    res.setHeader(
      'content-security-policy',
      `default-src 'self'; ${craftedai.cspDirectiveString()}`,
    );
    const user = currentUser(req);
    const widgetAgent = agentId ?? '<agent id from npx craftedai init>';
    res.type('html').send(`<!doctype html><title>Example shop</title>
<p>${user ? `Signed in as ${escapeHtml(user)}. <form method=post action=/logout><button>Log out</button></form>` : '<form method=post action=/login><input name=user value=member-1><button>Log in</button></form>'}</p>
<script src="${escapeHtml(craftedai.config.chatOrigin)}/widget.js" data-agent="${escapeHtml(widgetAgent)}"
        data-session-endpoint="/craftedai/session" async></script>`);
  });

  // The widget posts { agentId } as JSON. sessionHandler reads and parses that body itself, so no
  // app-wide body parser is mounted (and none can ever sit in front of the MCP guard).
  // With an agent id configured, the route mints for that agent only (anything else is a 403).
  app.post(
    '/craftedai/session',
    craftedai.express.sessionHandler({
      getUser: currentUser,
      ...(agentId === undefined ? {} : { agentIds: [agentId] }),
    }),
  );

  return app;
}
