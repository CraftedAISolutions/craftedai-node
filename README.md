# @craftedai/node

Server library for the CraftedAI embedded assistant. Three calls, not a security layer:

1. a **session route** your page's widget calls,
2. a **guard** on your MCP server that proves a request came from CraftedAI, for your org, for this
   server, for this body, once,
3. a **CSP** line.

Node >= 20.19. ESM and CommonJS. One runtime dependency (`jose`).

## Set up (about 5 minutes)

```bash
npm i @craftedai/node
npx craftedai init     # asks for the server key from "Connect your app", step 4
```

`init` calls CraftedAI with the key, generates `CRAFTEDAI_APP_SECRET` locally (it is never sent to
us), and appends to `.env`:

```
CRAFTEDAI_SECRET_KEY=cai_...   # web app only
CRAFTEDAI_APP_SECRET=...       # web app AND MCP server
CRAFTEDAI_ORG_ID=...           # public id
```

It never overwrites a value that is already set, and leaves an empty one alone: run it as often as
you like; it prints what it skipped. It then prints the routes for your framework and the widget
tag. If your MCP server is a separate service, give it `CRAFTEDAI_APP_SECRET` and
`CRAFTEDAI_ORG_ID` only.

The library reads `process.env`, not `.env` files: load yours with `node --env-file=.env`, your
framework, or dotenv. The server key is read from `CRAFTEDAI_SECRET_KEY` (environment or `.env`) or
a hidden prompt, never from the command line.

### Staging or a local CraftedAI

`npx craftedai init --api-origin <URL>` asks that API instead of production (`https://...`, or
`http://` for localhost; `--env-file <path>` picks another file). When the key's API or chat origin
is not production, `init` also writes `CRAFTEDAI_API_ORIGIN` and `CRAFTEDAI_CHAT_ORIGIN`, and the
library reads them: a token's issuer must equal `CRAFTEDAI_API_ORIGIN`, and the widget and CSP use
`CRAFTEDAI_CHAT_ORIGIN`. A production key writes neither.

## Rotating the app secret

`CRAFTEDAI_APP_SECRET` changes without downtime. `CRAFTEDAI_APP_SECRET_PREVIOUS` is only ever used
to verify; tokens are always signed with `CRAFTEDAI_APP_SECRET`, and `init` never writes it.

1. Make a new secret: `node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"`.
2. MCP server: set `CRAFTEDAI_APP_SECRET_PREVIOUS` to the current value and `CRAFTEDAI_APP_SECRET`
   to the new one. Deploy. It now accepts delegations signed with either.
3. Web app: set the same new `CRAFTEDAI_APP_SECRET`. Deploy. (One service doing both? Steps 2
   and 3 are one deploy.)
4. Five minutes later (a delegation lives 300 s), remove `CRAFTEDAI_APP_SECRET_PREVIOUS` and
   deploy the MCP server again.

## Use it (Express)

```ts
import { CraftedAI } from '@craftedai/node';
const craftedai = new CraftedAI();

// Web app: the widget's session route. Your auth runs first; return null when signed out.
app.post(
  '/craftedai/session',
  craftedai.express.sessionHandler({ getUser: (req) => req.user?.id }),
);

// On logout:
await craftedai.revokeSessions(userId);

// MCP server: the guard goes BEFORE express.json() or any body parser.
app.post('/mcp', craftedai.express.verifyRequest(), mcpHandler);
// req.craftedai = { orgId, integrationId, user, delegated, act }

// CSP: merge into your policy.
craftedai.cspDirectives(); // { 'script-src': [chatOrigin], 'frame-src': [chatOrigin] }
craftedai.cspDirectiveString(); // "script-src https://chat.craftedai.co; frame-src https://chat.craftedai.co;"
```

```html
<script
  src="https://chat.craftedai.co/widget.js"
  data-agent="<agent id>"
  data-session-endpoint="/craftedai/session"
  async
></script>
```

The user id `getUser` returns is 1 to 256 printable ASCII characters with no spaces. The session
route only accepts a JSON `POST` from a page (it needs the browser's `Origin`).
`new CraftedAI()` throws `config_invalid` while `CRAFTEDAI_APP_SECRET` is missing (see
[Options](#options)).

**Express notes.** The guard reads the raw body itself, then sets `req.rawBody` (the exact bytes)
and `req.body` (the parsed JSON), so a later `express.json()` has nothing left to do. It also sets
`req._body = true`, which Express 4's body-parser needs to skip a stream that is already drained.
This package is tested against Express 5; the Express 4 path is not covered by its tests. A body
parser mounted before the guard drains the stream, and the guard answers `body_mismatch`; to keep
a parser in front, have it store the bytes in `req.rawBody`.

**Fastify**

```ts
app.post('/craftedai/session', craftedai.fastify.sessionHandler({ getUser: (r) => r.user?.id }));
await app.register(async (mcp) => {
  craftedai.fastify.protect(mcp); // raw body + guard for every route in this scope
  mcp.post('/mcp', (request) => handle(craftedai.fastify.context(request)));
});
```

Always call `protect` inside `register`. It replaces the scope's body parsers; on the root
instance that would replace the parsers of every route in your app. It also installs an error
handler on the scope (for the 413 below), so do not call `setErrorHandler` on that scope after it.

**Next.js, Remix / React Router, Hono, Bun: anything `(Request) => Response`**

```ts
// app/craftedai/session/route.ts
export const POST = craftedai.fetch.sessionHandler({
  getUser: async (req) => (await auth(req))?.id,
});
// app/mcp/route.ts: pass the untouched Request (Hono: c.req.raw, before c.req.json())
export const POST = craftedai.fetch.verifyRequest((request, context) =>
  mcpHandler(request, context),
);
```

To verify by hand, `await craftedai.verifyMcpRequest(request)` returns `{ ok: true, context }` or
`{ ok: false, reason }`. It rejects with `CraftedAIError('payload_too_large')` for a body over the
limit, so answer that with a 413 yourself.

## What the guard answers

| status | body                                                          | when                                                                                                                                        |
| ------ | ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| 401    | `{ "error": "craftedai_verification_failed", "reason": ... }` | the request is not valid; see below                                                                                                         |
| 413    | `{ "error": "payload_too_large" }`                            | the body is over `maxBodyBytes` (1 MiB by default; set it per adapter: `verifyRequest({ maxBodyBytes })`, `protect(mcp, { maxBodyBytes })`) |
| 503    | `{ "error": "craftedai_verification_unavailable" }`           | the replay store failed (for example Redis is down); sends `Retry-After: 5`, calls `onError`, and your handler never runs                   |
| 500    | `{ "error": "craftedai_verification_unavailable" }`           | the client is misconfigured (`config_missing` or `config_invalid`); calls `onError`                                                         |

A request never reaches your handler unless it verified. The session route answers `200` with the
embed session, or `400 invalid_request` / `400 origin_required` / `401 unauthenticated` /
`403 agent_not_allowed` / `403 embed_origin_not_allowed` / `403 agent_not_allowed_for_key` /
`404 agent_unavailable` / `415 unsupported_media_type`, `413` for a body over 16 KiB (Express and
fetch; Fastify applies its own body limit), `502 session_unavailable` when the mint failed and
`500 session_unavailable` when `getUser` threw.

## When the guard says 401

Every rejection is `401 { "error": "craftedai_verification_failed", "reason": "...", "message"?: "..." }`.
The "Connect your app" checklist shows the same reason.

| reason                                     | usual cause                                                                                                                                           |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `wrong_audience`                           | Behind a proxy or load balancer the server sees an internal URL. Set `publicUrl` (or `CRAFTEDAI_PUBLIC_URL`) to the MCP URL you entered in CraftedAI. |
| `body_mismatch`                            | A body parser ran before the guard, or a proxy changed the body. Mount the guard first.                                                               |
| `expired`                                  | This server's clock is more than 60 s off. Sync it (NTP).                                                                                             |
| `wrong_org`                                | Another CraftedAI workspace is pointed at this URL, or `CRAFTEDAI_ORG_ID` is wrong.                                                                   |
| `wrong_issuer`                             | Staging vs production: set `CRAFTEDAI_API_ORIGIN` (see [Staging](#staging-or-a-local-craftedai)).                                                     |
| `unknown_key`                              | The CraftedAI signing keys could not be fetched, or the token was signed by a key we never published.                                                 |
| `replayed`                                 | The same request arrived twice. With several instances, use the Redis store below.                                                                    |
| `delegation_missing`, `delegation_invalid` | The web app and the MCP disagree on `CRAFTEDAI_APP_SECRET`, or the delegation expired (it lives 300 s), or its `iat` is more than 60 s ahead.         |
| `delegation_user_mismatch`                 | The delegation was minted for another user.                                                                                                           |
| `delegation_exhausted`                     | 20 tool calls on one delegation (`delegationCallLimit`).                                                                                              |
| `missing_token`, `bad_signature`           | The request did not come from CraftedAI.                                                                                                              |

### Proxies and `publicUrl`

The token's audience (`aud`) is the exact URL CraftedAI calls, and the guard compares it with the
URL of each request as the framework reports it (scheme, host and path, without the query).
`X-Forwarded-*` and `Forwarded` are never read, so behind a proxy or load balancer, and on fetch
hosts that build `request.url` from forwarded headers, set `publicUrl` to the URL registered in
CraftedAI:

```ts
new CraftedAI({ publicUrl: 'https://mcp.example.com/mcp' }); // or CRAFTEDAI_PUBLIC_URL
```

The compare is an exact string compare: write the URL as registered (lower-case host, no default
port such as `:443`, no query). One URL can have several forms, so `publicUrl` also takes a list
(or a comma-separated `CRAFTEDAI_PUBLIC_URL`). A server using the older SSE transport is called on
two URLs, the event stream and the messages endpoint; list both. Express's `trust proxy` and
Fastify's `trustProxy` change what the framework reports and are honoured, but only through the
framework.

## Several instances

The default replay store is in memory and per process. Behind a load balancer, share one:

```ts
import { Redis } from 'ioredis';
import { CraftedAI, redisReplayStore } from '@craftedai/node';
const craftedai = new CraftedAI({
  replayStore: redisReplayStore(new Redis(process.env.REDIS_URL)),
});
```

The in-memory store keeps at most 100,000 entries and drops the oldest when full, which opens a
replay window at very high request rates (see `MemoryReplayStore`'s `maxEntries`); a shared store
has no such limit. `redisReplayStore` takes any client with `get`, `set` and `eval` (ioredis fits;
wrap node-redis, see the type's comment). A delegated request writes two keys in one script, so on
Redis Cluster use a standalone or Sentinel deployment.

Two instances can race for the last call a delegation allows (20 by default). The store decides
atomically: one wins, the other answers `delegation_exhausted`, and the loser's request id is not
consumed.

## Options

`new CraftedAI({ secretKey, appSecret, previousAppSecret, orgId, apiOrigin, chatOrigin, publicUrl, requireDelegation = true, delegationCallLimit = 20, replayStore, onError, fetch, now, env })`.
Every credential and origin option falls back to its `CRAFTEDAI_*` environment variable.

Construction throws `CraftedAIError('config_invalid')` for a malformed origin or app secret, for
the published test-vector secret, and when `requireDelegation` (the default) is on without an app
secret. A missing server key or org id does not throw there: the operation that needs it throws
`config_missing` (an MCP-only service has no server key). With `requireDelegation: false` the
delegation check is skipped, so `context.user` is CraftedAI's claim alone, not something your web
app vouched for.

### Errors and `onError`

Every error this library throws is a `CraftedAIError` with a stable `code` and a message that
never contains a secret or a token. The library never logs.

| code                        | meaning                                                                         |
| --------------------------- | ------------------------------------------------------------------------------- |
| `config_missing`            | a setting the operation needs (server key, app secret, org id) is not set       |
| `config_invalid`            | a setting is present but malformed, or `maxBodyBytes` / `ttlSeconds` is invalid |
| `invalid_argument`          | a bad argument, for example a user id with a space                              |
| `invalid_credentials`       | CraftedAI refused the server key (unknown, revoked or retired)                  |
| `agent_not_allowed_for_key` | the key may not mint for this agent                                             |
| `agent_unavailable`         | the agent is missing, unpublished or not embed-enabled                          |
| `embed_origin_not_allowed`  | the page's origin is not on the agent's website list                            |
| `invalid_request`           | CraftedAI answered 400 to the mint                                              |
| `api_unavailable`           | CraftedAI could not be reached, timed out, or answered something unexpected     |
| `payload_too_large`         | a request body is over `maxBodyBytes` (thrown by `verifyMcpRequest`)            |

`onError(error)` is how you see failures the adapters turn into a response. It receives the error
behind every 5xx the library answers for you (a replay store that is down, a failed mint, a
`getUser` that threw). A mint that failed for an expected reason, such as an unknown agent, is
answered without it. Raw pass-through: a `CraftedAIError` is safe to log, but an error from **your
replay store** (including the errors of the Redis client behind `redisReplayStore`), **your
`getUser`** or **your `now`** reaches `onError` exactly as thrown, and its message is yours. The
signing-key `fetch` is not one of them: a failed response is always wrapped in a `CraftedAIError`
(`api_unavailable`) or swallowed into `unknown_key`. When in doubt, log `error.name` and
`error.code` only. A throwing `onError` never changes the response.

Two things you may notice in the Express adapter. These errors are answered by the guard and not
passed to `next(error)`, so Express's default error handler, which prints whatever reaches
`next(error)`, never shows them: without an `onError` they are silent. And a client that
disconnects while the body is being read arrives in `onError` as a plain
`Error('the request was closed before its body was read')`; filter it out if it is noise for you.

## Other stacks

The wire protocol is plain JWS/JWKS. A request carries `X-CraftedAI-Request`, an EdDSA JWS
(`typ: craftedai-req+jwt`) whose keys are at `{api origin}/.well-known/jwks.json`. Verify, in
order: signature (refetch the JWKS on an unknown `kid`, at most every 30 s); `iss` is the API
origin; `sub` is your org id; `aud` is your MCP URL; `exp` in the future and `iat` at most 60 s
ahead; `jti` unseen; `bh` = base64url(SHA-256(raw body)); and on calls with `act`, an
`X-CraftedAI-Actor-Delegation` HS256 JWT keyed with the UTF-8 bytes of your app secret
(`iss craftedai-node`, `aud craftedai-delegation`, `sub` = `act.externalUserId`, `org` = your org
id), at most 20 uses. The repository's `test/vectors/request-token.json` holds test vectors for
every reason code.

## License

MIT
