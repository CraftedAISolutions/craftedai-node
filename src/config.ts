import { APP_SECRET_RE, DEFAULT_API_ORIGIN, DEFAULT_CHAT_ORIGIN } from './contract.js';
import { CraftedAIError } from './errors.js';
import type { ReplayStore } from './replay/replay-store.js';
import { isTestVectorAppSecret } from './test-material.js';

/** Environment variable names (spec §4.3). Only the first three are written by `npx craftedai init` by default. */
export const ENV = {
  secretKey: 'CRAFTEDAI_SECRET_KEY',
  appSecret: 'CRAFTEDAI_APP_SECRET',
  previousAppSecret: 'CRAFTEDAI_APP_SECRET_PREVIOUS',
  orgId: 'CRAFTEDAI_ORG_ID',
  apiOrigin: 'CRAFTEDAI_API_ORIGIN',
  chatOrigin: 'CRAFTEDAI_CHAT_ORIGIN',
  publicUrl: 'CRAFTEDAI_PUBLIC_URL',
} as const;

export interface CraftedAIOptions {
  /** `cai_…` server key. Web app only. Default `process.env.CRAFTEDAI_SECRET_KEY`. */
  secretKey?: string;
  /** Delegation signing secret. Web app + MCP. Default `process.env.CRAFTEDAI_APP_SECRET`. */
  appSecret?: string;
  /**
   * The app secret you are rotating away from. Delegations signed with it are still
   * accepted by the MCP guard; nothing is ever signed with it. Set it on the MCP
   * while the web app moves to the new `CRAFTEDAI_APP_SECRET`, then remove it.
   * Default `process.env.CRAFTEDAI_APP_SECRET_PREVIOUS`.
   */
  previousAppSecret?: string;
  /** CraftedAI organization id. Default `process.env.CRAFTEDAI_ORG_ID`. */
  orgId?: string;
  /** Default `CRAFTEDAI_API_ORIGIN` or `https://api.craftedai.co`. The only accepted request-token `iss`. */
  apiOrigin?: string;
  /** Default `CRAFTEDAI_CHAT_ORIGIN` or `https://chat.craftedai.co`. Serves widget.js and the frame. */
  chatOrigin?: string;
  /**
   * The MCP URL exactly as registered in CraftedAI (request-token `aud`). Set it
   * when the server sits behind a proxy or load balancer and sees an internal
   * URL (spec §12.1). Default `CRAFTEDAI_PUBLIC_URL`, else derived per request.
   */
  publicUrl?: string | readonly string[];
  /** Require a delegation token on end-user tool calls (spec §5.2 rule 8). Default true. */
  requireDelegation?: boolean;
  /** Tool calls allowed per delegation token. Default 20. */
  delegationCallLimit?: number;
  /** Default: in-memory LRU (single instance). Use `redisReplayStore(client)` when running several. */
  replayStore?: ReplayStore;
  /** Called with every error a framework adapter turns into a response. Never receives a secret. */
  onError?: (error: unknown) => void;
  fetch?: typeof fetch;
  /** Unix milliseconds; test seam. */
  now?: () => number;
  /** Default `process.env`. */
  env?: Readonly<Record<string, string | undefined>>;
}

export interface ResolvedConfig {
  secretKey: string | undefined;
  appSecret: string | undefined;
  previousAppSecret: string | undefined;
  orgId: string | undefined;
  apiOrigin: string;
  chatOrigin: string;
  publicUrl: readonly string[] | undefined;
  requireDelegation: boolean;
  delegationCallLimit: number;
}

/** Config members that are credentials; never enumerable, never printed. */
const SECRET_CONFIG_FIELDS = ['secretKey', 'appSecret', 'previousAppSecret'] as const;

const blankToUndefined = (value: string | undefined): string | undefined =>
  value === undefined || value.trim() === '' ? undefined : value.trim();

/**
 * A bare origin: `https://host[:port]`, or `http://` only for `localhost` / `127.0.0.1` (local
 * development). No path, query, fragment, userinfo or trailing slash: the value must equal the
 * URL's own `origin`, so `https://a.test/` and `https://a.test:443` are refused rather than
 * silently rewritten. The origin is compared as a string later (`iss`, CSP), so it must be exact.
 * The message never echoes the value.
 */
export function normalizeOrigin(name: string, value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new CraftedAIError('config_invalid', `${name} must be a URL origin`);
  }
  const loopback = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw new CraftedAIError('config_invalid', `${name} must use https (http only for localhost)`);
  }
  if (value.toLowerCase() !== url.origin) {
    throw new CraftedAIError(
      'config_invalid',
      `${name} must be a bare origin such as https://host (no path, query, fragment or trailing slash)`,
    );
  }
  return url.origin;
}

/**
 * An app secret must be base64url of at least 32 random bytes, and must not be the secret the
 * shared test vectors publish. `label` is the env var name; the value is never put in a message.
 */
export function assertAppSecret(label: string, value: string): void {
  if (!APP_SECRET_RE.test(value)) {
    throw new CraftedAIError(
      'config_invalid',
      `${label} must be base64url of at least 32 random bytes (43+ characters)`,
    );
  }
  if (isTestVectorAppSecret(value)) {
    throw new CraftedAIError(
      'config_invalid',
      `${label} is the published test-vector secret; generate your own (npx craftedai init)`,
    );
  }
}

/**
 * Reads options then env and validates what is present. A missing secret key or org id is not an
 * error here (an MCP-only service has no key), each operation checks what it needs; but a value
 * that is present must be well-formed, and delegation cannot be required without an app secret.
 */
export function resolveConfig(options: CraftedAIOptions): ResolvedConfig {
  const env = options.env ?? process.env;
  const publicUrlEnv = blankToUndefined(env[ENV.publicUrl]);
  const publicUrl =
    options.publicUrl === undefined
      ? publicUrlEnv?.split(',').map((url) => url.trim())
      : typeof options.publicUrl === 'string'
        ? [options.publicUrl]
        : [...options.publicUrl];
  const limit = options.delegationCallLimit ?? 20;
  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw new CraftedAIError('config_invalid', 'delegationCallLimit must be a positive integer');
  }
  const appSecret = blankToUndefined(options.appSecret ?? env[ENV.appSecret]);
  const previousAppSecret = blankToUndefined(
    options.previousAppSecret ?? env[ENV.previousAppSecret],
  );
  const requireDelegation = options.requireDelegation ?? true;
  if (appSecret !== undefined) assertAppSecret(ENV.appSecret, appSecret);
  if (previousAppSecret !== undefined) assertAppSecret(ENV.previousAppSecret, previousAppSecret);
  if (requireDelegation && appSecret === undefined) {
    throw new CraftedAIError(
      'config_invalid',
      `${ENV.appSecret} is required while requireDelegation is on (run npx craftedai init, or pass requireDelegation: false)`,
    );
  }
  const config: ResolvedConfig = {
    secretKey: blankToUndefined(options.secretKey ?? env[ENV.secretKey]),
    appSecret,
    previousAppSecret,
    orgId: blankToUndefined(options.orgId ?? env[ENV.orgId]),
    apiOrigin: normalizeOrigin(
      'apiOrigin',
      options.apiOrigin ?? blankToUndefined(env[ENV.apiOrigin]) ?? DEFAULT_API_ORIGIN,
    ),
    chatOrigin: normalizeOrigin(
      'chatOrigin',
      options.chatOrigin ?? blankToUndefined(env[ENV.chatOrigin]) ?? DEFAULT_CHAT_ORIGIN,
    ),
    publicUrl,
    requireDelegation,
    delegationCallLimit: limit,
  };
  // Readable (`config.appSecret`) but invisible to JSON.stringify, spread, Object.keys and
  // util.inspect, so logging or serialising the client or its config cannot leak a secret.
  for (const field of SECRET_CONFIG_FIELDS) {
    Object.defineProperty(config, field, {
      value: config[field],
      enumerable: false,
      writable: false,
      configurable: false,
    });
  }
  return config;
}

/** What `toJSON` / `util.inspect` show: the config with every secret replaced. */
export function redactConfig(config: ResolvedConfig): Record<string, unknown> {
  const redacted: Record<string, unknown> = { ...config };
  for (const field of SECRET_CONFIG_FIELDS) {
    redacted[field] = config[field] === undefined ? undefined : '[redacted]';
  }
  return redacted;
}

export function requireSecretKey(config: ResolvedConfig): string {
  if (config.secretKey === undefined) {
    throw new CraftedAIError(
      'config_missing',
      `${ENV.secretKey} is not set (run npx craftedai init)`,
    );
  }
  if (!config.secretKey.startsWith('cai_')) {
    throw new CraftedAIError('config_invalid', `${ENV.secretKey} must be a cai_ server key`);
  }
  return config.secretKey;
}

/** The secret itself was validated when the config was resolved. */
export function requireAppSecret(config: ResolvedConfig): string {
  if (config.appSecret === undefined) {
    throw new CraftedAIError(
      'config_missing',
      `${ENV.appSecret} is not set (run npx craftedai init)`,
    );
  }
  return config.appSecret;
}

export function requireOrgId(config: ResolvedConfig): string {
  if (config.orgId === undefined) {
    throw new CraftedAIError('config_missing', `${ENV.orgId} is not set (run npx craftedai init)`);
  }
  return config.orgId;
}
