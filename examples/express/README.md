# Express example: web app and MCP server in one process

One Express app that is both your web app (login, the widget, the session route) and your MCP
server (the guarded `POST /mcp` with a read-only `get_order_status` tool).

```bash
npm install
npx craftedai init      # writes CRAFTEDAI_* to .env, prints the widget tag
npm start               # http://localhost:4000
```

Everything comes from the environment (see `.env.example`); no secret lives in the code.
`CRAFTEDAI_PUBLIC_URL` is optional: set it only behind a proxy or load balancer.

- `app.js`: the app (`createApp`). The MCP guard is mounted before any body parser.
- `server.js`: reads `.env`, builds the `CraftedAI` client and listens.
- `app.test.js`: signed requests reach the MCP tool, unsigned ones get 401 (`npm test`).
  It signs with the library's own test signer (a fresh key), never the published vector keys.

The login is a toy cookie; replace it with your own auth.
