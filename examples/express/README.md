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

- `app.js`: the app (`createApp`). The MCP guard is mounted before any body parser. With
  `CRAFTEDAI_AGENT_ID` set, the session route mints for that agent only.
- `server.js`: reads `.env`, builds the `CraftedAI` client (with `onError`) and listens.
- `app.test.js`: signed requests reach the MCP tool, unsigned ones get 401. `npm test` runs only
  inside the @craftedai/node repository: the test imports the library's own test signer (a fresh
  key, never the published vector keys), which is not published. Copy `app.js`, `server.js` and
  `package.json`, not the test.

The login is a toy cookie; replace it with your own auth.

## Things to know before you copy it

- **More than one instance?** Use `redisReplayStore(client)`; the default in-memory store is per
  process.
- **`onError`** receives every error behind a 5xx the library answered for you: a replay store that
  is down (503), a failed session mint (502), a `getUser` that threw. A `CraftedAIError` has a
  stable `code` and a message that never carries a secret, but an error from your own replay store
  (or the Redis client behind it), `getUser` or `now` reaches it as thrown. The library's own
  `fetch` is never a raw source: its failures are always wrapped. `server.js` logs only the error's `name` and `code`;
  do the same unless you know your errors are clean.
- **`zod`** is a required peer dependency of `@modelcontextprotocol/sdk`, so it is in this
  example's `package.json` even though the code does not import it.

## For maintainers

This example depends on the library by `file:../..`, and its lock records the library's version and
ranges. A release re-locks it (`npm install --package-lock-only` here and in the repository root);
`test/lockfiles.test.ts` fails the gate when either lock is behind.
