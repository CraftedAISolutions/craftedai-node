import { randomBytes } from 'node:crypto';
import { isAbsolute, relative, resolve } from 'node:path';
import { assertAppSecret, ENV, normalizeOrigin } from '../config.js';
import { DEFAULT_API_ORIGIN, DEFAULT_CHAT_ORIGIN, KEY_INFO_PATH } from '../contract.js';
import { CraftedAIError } from '../errors.js';
import { isTestVectorAppSecret } from '../test-material.js';
import { mergeEnv, parseEnvKeys, type EnvEntry } from './env-file.js';
import { cspSnippet, detectFramework, routeSnippet, widgetSnippet } from './frameworks.js';

/** `GET /portal/v1/key-info` (core-api `KeyInfoResponseSchema`). */
export interface KeyInfo {
  orgId: string;
  apiOrigin: string;
  chatOrigin: string;
  agents: { id: string; name: string }[];
}

export interface InitIo {
  cwd: string;
  env: Readonly<Record<string, string | undefined>>;
  args: readonly string[];
  /** The file's text, or null when it does not exist. */
  readFile(path: string): Promise<string | null>;
  /** Appends to the file. A new file is created with mode 0600; an existing file keeps its mode. */
  appendFile(path: string, text: string): Promise<void>;
  /** `secret: true` must not echo what is typed. */
  prompt(question: string, options: { secret: boolean }): Promise<string>;
  fetch: typeof fetch;
  print(line: string): void;
  randomSecret?: (() => string) | undefined;
}

/** A failure whose message is safe to show: it never carries a key, a secret or a response body. */
export class InitError extends Error {
  public override readonly name = 'InitError';
}

export const USAGE =
  'Usage: npx craftedai init [--api-origin URL] [--env-file .env]\n' +
  '  The server key (cai_...) is read from CRAFTEDAI_SECRET_KEY or .env, or asked for with a hidden prompt.';

const KEY_RE = /^cai_[A-Za-z0-9_-]+$/;
/** Ids from key-info go into .env and into a printed tag, so only plain characters pass. */
const PLAIN_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;
const KEY_INFO_TIMEOUT_MS = 10_000;

interface InitOptions {
  apiOrigin: string | undefined;
  envFile: string;
}

/** Reads `--api-origin` and `--env-file`. A bad argument is never echoed: it could be a pasted key. */
function parseOptions(args: readonly string[]): InitOptions {
  const options: InitOptions = { apiOrigin: undefined, envFile: '.env' };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? '';
    if (arg === '--key' || arg.startsWith('--key=')) {
      throw new InitError(
        'the server key is not accepted on the command line (it would sit in your shell history and the process list). ' +
          'Set CRAFTEDAI_SECRET_KEY in the environment, or run init and paste it at the hidden prompt.',
      );
    }
    const equals = arg.indexOf('=');
    const name = equals === -1 ? arg : arg.slice(0, equals);
    if (name !== '--api-origin' && name !== '--env-file') {
      throw new InitError(`unexpected argument.\n${USAGE}`);
    }
    let value: string | undefined;
    if (equals === -1) {
      index += 1;
      value = args[index];
    } else {
      value = arg.slice(equals + 1);
    }
    if (value === undefined || value === '') throw new InitError(`${name} needs a value.`);
    if (name === '--api-origin') options.apiOrigin = value;
    else options.envFile = value;
  }
  return options;
}

const blank = (value: string | undefined): string | undefined =>
  value === undefined || value.trim() === '' ? undefined : value.trim();

/** Terminal control characters in a server-supplied name must not reach the screen. */
const printable = (text: string): string =>
  [...text]
    .filter((char) => {
      const code = char.codePointAt(0) ?? 0;
      return code > 0x1f && (code < 0x7f || code > 0x9f);
    })
    .join('');

function readKeyInfo(body: unknown): KeyInfo | null {
  if (typeof body !== 'object' || body === null) return null;
  const { orgId, apiOrigin, chatOrigin, agents } = body as Record<string, unknown>;
  if (typeof orgId !== 'string' || !PLAIN_ID_RE.test(orgId)) return null;
  if (typeof apiOrigin !== 'string' || typeof chatOrigin !== 'string' || !Array.isArray(agents)) {
    return null;
  }
  let origins: { apiOrigin: string; chatOrigin: string };
  try {
    // `apiOrigin` becomes the request-token issuer, compared as a string: it must be exact.
    origins = {
      apiOrigin: normalizeOrigin('apiOrigin', apiOrigin),
      chatOrigin: normalizeOrigin('chatOrigin', chatOrigin),
    };
  } catch {
    return null;
  }
  const parsed = (agents as unknown[]).flatMap((agent) => {
    if (typeof agent !== 'object' || agent === null) return [];
    const { id, name } = agent as Record<string, unknown>;
    if (typeof id !== 'string' || !PLAIN_ID_RE.test(id) || typeof name !== 'string') return [];
    return [{ id, name: printable(name) }];
  });
  return { orgId, ...origins, agents: parsed };
}

async function fetchKeyInfo(io: InitIo, apiOrigin: string, secretKey: string): Promise<KeyInfo> {
  let response: Response;
  try {
    response = await io.fetch(`${apiOrigin}${KEY_INFO_PATH}`, {
      method: 'GET',
      headers: { authorization: `Bearer ${secretKey}`, accept: 'application/json' },
      // The key travels in this request: a redirect would hand it to another host.
      redirect: 'error',
      signal: AbortSignal.timeout(KEY_INFO_TIMEOUT_MS),
    });
  } catch {
    // The error text is not shown: a transport error can quote the request.
    throw new InitError(`could not reach ${apiOrigin}`);
  }
  if (response.status === 401) {
    throw new InitError(
      'CraftedAI refused that key. Copy the server key from step 4 of "Connect your app".',
    );
  }
  if (response.status === 503) {
    const body = (await response.json().catch(() => null)) as { error?: unknown } | null;
    if (body?.error === 'onboarding_not_configured') {
      throw new InitError(
        `${apiOrigin} is not set up for onboarding yet (it has no public API origin).`,
      );
    }
  }
  if (!response.ok) throw new InitError(`CraftedAI answered ${response.status} to key-info`);
  const info = readKeyInfo(await response.json().catch(() => null));
  if (info === null) throw new InitError('CraftedAI sent an unexpected key-info response');
  return info;
}

/** Where `.gitignore` would have to mention the file; null when it lives outside the project. */
function isGitignored(gitignore: string, relativeName: string): boolean {
  const patterns = new Set(
    gitignore
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line !== '' && !line.startsWith('#') && !line.startsWith('!')),
  );
  const candidates = [relativeName, `/${relativeName}`];
  if (relativeName.startsWith('.env')) candidates.push('.env*', '/.env*', '.env.*', '/.env.*');
  return candidates.some((candidate) => patterns.has(candidate));
}

/**
 * `npx craftedai init [--api-origin URL] [--env-file .env]` (spec §8): reads the server
 * key (environment, `.env`, or a hidden prompt, never argv), asks key-info who it belongs
 * to, generates the app secret, appends what is missing to `.env` — never overwriting a
 * value, never filling an empty one — and prints the routes for the detected framework.
 * Returns the process exit code.
 */
export async function runInit(io: InitIo): Promise<number> {
  const options = parseOptions(io.args);
  const envPath = resolve(io.cwd, options.envFile);
  const envLabel = isAbsolute(options.envFile) ? envPath : relative(io.cwd, envPath);
  const existing = (await io.readFile(envPath)) ?? '';
  const present = parseEnvKeys(existing);

  const apiOrigin = normalizeOrigin(
    'api origin',
    options.apiOrigin ??
      blank(io.env[ENV.apiOrigin]) ??
      blank(present.get(ENV.apiOrigin)) ??
      DEFAULT_API_ORIGIN,
  );
  const secretKey = (
    blank(io.env[ENV.secretKey]) ??
    blank(present.get(ENV.secretKey)) ??
    (await io.prompt('Paste the server key (cai_...) from "Connect your app", step 4: ', {
      secret: true,
    }))
  ).trim();
  if (!KEY_RE.test(secretKey)) throw new InitError('that is not a cai_ server key');

  const info = await fetchKeyInfo(io, apiOrigin, secretKey);
  const appSecret = (io.randomSecret ?? (() => randomBytes(32).toString('base64url')))();
  assertAppSecret(ENV.appSecret, appSecret);

  // Never CRAFTEDAI_APP_SECRET_PREVIOUS: rotation is done by hand (spec §4.3).
  const entries: EnvEntry[] = [
    {
      key: ENV.secretKey,
      value: secretKey,
      comment: 'Server key. Web app only; never in the browser.',
    },
    {
      key: ENV.appSecret,
      value: appSecret,
      comment: 'Signs delegation tokens. Web app AND MCP server; never sent to CraftedAI.',
    },
    { key: ENV.orgId, value: info.orgId, comment: 'Your CraftedAI organization id (public).' },
  ];
  if (info.apiOrigin !== DEFAULT_API_ORIGIN) {
    entries.push({
      key: ENV.apiOrigin,
      value: info.apiOrigin,
      comment: 'Non-production CraftedAI API.',
    });
  }
  if (info.chatOrigin !== DEFAULT_CHAT_ORIGIN) {
    entries.push({
      key: ENV.chatOrigin,
      value: info.chatOrigin,
      comment: 'Non-production CraftedAI chat.',
    });
  }
  for (const entry of entries) {
    if (isTestVectorAppSecret(entry.value)) {
      throw new InitError(`${entry.key} would be a published test value; nothing was written`);
    }
  }

  const merged = mergeEnv(existing, entries);
  if (merged.written.length > 0) {
    // Only the new block goes to disk: the bytes already in the file are never rewritten.
    await io.appendFile(envPath, merged.content.slice(existing.length));
  }

  io.print(`The server key belongs to organization ${info.orgId}.`);
  for (const key of merged.written) io.print(`  wrote   ${key}`);
  for (const { key, existing: value } of merged.skipped) {
    io.print(
      value === ''
        ? `  skipped ${key} (present but empty in ${envLabel}; left unchanged, set it by hand)`
        : `  skipped ${key} (already set in ${envLabel}; left unchanged)`,
    );
    if (value !== '' && key === ENV.secretKey && value !== secretKey) {
      io.print(
        `  WARNING: ${envLabel} has a different ${ENV.secretKey} than the one just checked. Check which one your app should use.`,
      );
    }
  }
  const appSecretHeld = present.get(ENV.appSecret);
  if (appSecretHeld !== undefined && appSecretHeld !== '') {
    try {
      assertAppSecret(ENV.appSecret, appSecretHeld);
    } catch (error) {
      if (!(error instanceof CraftedAIError)) throw error;
      io.print(`  WARNING: the existing value in ${envLabel}: ${error.message}.`);
    }
  }
  const publicValues: [string, string][] = [
    [ENV.orgId, info.orgId],
    [ENV.apiOrigin, info.apiOrigin],
    [ENV.chatOrigin, info.chatOrigin],
  ];
  for (const [key, expected] of publicValues) {
    const held = blank(present.get(key));
    if (held !== undefined && held !== expected) {
      io.print(
        `  WARNING: ${envLabel} has ${key}=${held}, but this key belongs to ${expected}. Fix it by hand.`,
      );
    }
  }
  if (merged.written.length > 0 && !relative(io.cwd, envPath).startsWith('..')) {
    const gitignore = (await io.readFile(resolve(io.cwd, '.gitignore'))) ?? '';
    if (!isGitignored(gitignore, relative(io.cwd, envPath))) {
      io.print(`  WARNING: ${envLabel} is not in .gitignore. Add it before you commit.`);
    }
  }
  io.print('');
  io.print(
    `If your MCP server is a separate service, give it ${ENV.appSecret} and ${ENV.orgId} (same values).`,
  );
  io.print('');

  io.print(
    routeSnippet(detectFramework(parseJson(await io.readFile(resolve(io.cwd, 'package.json'))))),
  );
  io.print('');
  io.print(cspSnippet(info.chatOrigin));
  io.print('');
  const [agent, ...others] = info.agents;
  if (agent === undefined) {
    io.print('This key cannot mint for any agent yet: finish "Connect your app" step 4 first.');
  } else {
    io.print(`Widget for "${agent.name}":`);
    io.print(widgetSnippet(info.chatOrigin, agent.id));
    for (const other of others) {
      io.print(`Another agent this key can mint for: "${other.name}" (data-agent="${other.id}")`);
    }
  }
  return 0;
}

function parseJson(text: string | null): unknown {
  if (text === null) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}
