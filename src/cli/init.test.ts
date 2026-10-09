import { describe, expect, it } from 'vitest';
import { APP_SECRET_RE } from '../contract.js';
import { jsonResponse } from '../../test/helpers/core-api-stub.js';
import { vectors } from '../../test/helpers/vectors.js';
import { parseEnvKeys } from './env-file.js';
import { InitError, runInit, type InitIo } from './init.js';

const KEY = `cai_${'k'.repeat(43)}`;
const KEY_INFO = {
  orgId: 'org-1',
  apiOrigin: 'https://api.craftedai.co',
  chatOrigin: 'https://chat.craftedai.co',
  agents: [{ id: '44444444-4444-4444-8444-444444444444', name: 'Support' }],
};
const GENERATED = (n: number) => `generated-secret-${n}-${'x'.repeat(30)}`;

interface FetchCall {
  url: string;
  init: RequestInit;
}

function fakeIo(files: Record<string, string>, overrides: Partial<InitIo> = {}) {
  const fs = new Map(Object.entries(files));
  const out: string[] = [];
  const appends: { path: string; text: string }[] = [];
  const calls: FetchCall[] = [];
  let secrets = 0;
  const io: InitIo = {
    cwd: '/app',
    env: { CRAFTEDAI_SECRET_KEY: KEY },
    args: [],
    readFile: (path) => Promise.resolve(fs.get(path) ?? null),
    appendFile: (path, text) => {
      appends.push({ path, text });
      fs.set(path, (fs.get(path) ?? '') + text);
      return Promise.resolve();
    },
    prompt: () => Promise.reject(new Error('must not prompt')),
    fetch: ((url: string, init: RequestInit) => {
      calls.push({ url, init });
      return Promise.resolve(jsonResponse(200, KEY_INFO));
    }) as unknown as typeof fetch,
    print: (line) => out.push(line),
    randomSecret: () => GENERATED((secrets += 1)),
    ...overrides,
  };
  return { io, fs, out, appends, calls };
}

const answering = (status: number, body: unknown) =>
  (() => Promise.resolve(jsonResponse(status, body))) as unknown as typeof fetch;

describe('npx craftedai init', () => {
  it('writes the three values and prints the express route and widget tag', async () => {
    const { io, fs, out } = fakeIo({
      '/app/package.json': '{"dependencies":{"express":"5.2.1"}}',
      '/app/.gitignore': '.env\n',
    });
    expect(await runInit(io)).toBe(0);
    const env = parseEnvKeys(fs.get('/app/.env') ?? '');
    expect(env.get('CRAFTEDAI_SECRET_KEY')).toBe(KEY);
    expect(env.get('CRAFTEDAI_APP_SECRET')).toBe(GENERATED(1));
    expect(env.get('CRAFTEDAI_ORG_ID')).toBe('org-1');
    expect(env.has('CRAFTEDAI_API_ORIGIN')).toBe(false);
    expect(env.has('CRAFTEDAI_CHAT_ORIGIN')).toBe(false);
    const printed = out.join('\n');
    expect(printed).toContain('craftedai.express.verifyRequest(');
    expect(printed).toContain('data-agent="44444444-4444-4444-8444-444444444444"');
    expect(printed).toContain(
      'script-src https://chat.craftedai.co; frame-src https://chat.craftedai.co;',
    );
    expect(printed).toContain('cspDirectiveString()');
    expect(printed).toContain('publicUrl');
    expect(printed).not.toContain(KEY);
    expect(printed).not.toContain('generated-secret');
    expect(printed).toContain('  wrote   CRAFTEDAI_SECRET_KEY');
    expect(printed).not.toContain('.gitignore');
  });

  it('prints the snippet of the detected framework', async () => {
    const fastify = fakeIo({ '/app/package.json': '{"dependencies":{"fastify":"5"}}' });
    await runInit(fastify.io);
    expect(fastify.out.join('\n')).toContain('craftedai.fastify.protect(');
    const next = fakeIo({ '/app/package.json': '{"dependencies":{"next":"15"}}' });
    await runInit(next.io);
    expect(next.out.join('\n')).toContain('craftedai.fetch.sessionHandler(');
    const none = fakeIo({ '/app/package.json': 'not json' });
    await runInit(none.io);
    expect(none.out.join('\n')).toContain('craftedai.fetch.verifyRequest(');
  });

  it('spec §12.4: running twice never changes the app secret and says what it skipped', async () => {
    const { io, fs, out } = fakeIo({});
    await runInit(io);
    const first = fs.get('/app/.env');
    out.length = 0;
    await runInit(io);
    expect(fs.get('/app/.env')).toBe(first);
    expect(out.filter((l) => l.includes('skipped'))).toHaveLength(3);
    expect(out.filter((l) => l.includes('wrote'))).toHaveLength(0);
  });

  it('spec §12.4: an existing .env keeps every value; only missing keys are appended', async () => {
    const existing =
      'DATABASE_URL=postgres://x\nCRAFTEDAI_APP_SECRET=keep-me-keep-me-keep-me-keep-me-keep-me-123\n';
    const { io, fs, out, appends } = fakeIo({ '/app/.env': existing });
    await runInit(io);
    const content = fs.get('/app/.env') ?? '';
    expect(content.startsWith(existing)).toBe(true);
    expect(parseEnvKeys(content).get('CRAFTEDAI_APP_SECRET')).toBe(
      'keep-me-keep-me-keep-me-keep-me-keep-me-123',
    );
    expect(out.join('\n')).toContain('skipped CRAFTEDAI_APP_SECRET');
    // Only the new block is handed to the file system; the old bytes are never rewritten.
    expect(appends).toHaveLength(1);
    expect(appends[0]!.text).toBe(content.slice(existing.length));
    expect(appends[0]!.text).not.toContain('keep-me');
  });

  it('skips a key that is present but empty, and says it is empty (Ruling 11)', async () => {
    const existing = 'CRAFTEDAI_APP_SECRET=\nCRAFTEDAI_ORG_ID=""\n';
    const { io, fs, out } = fakeIo({ '/app/.env': existing });
    await runInit(io);
    const content = fs.get('/app/.env') ?? '';
    expect(content.startsWith(existing)).toBe(true);
    const env = parseEnvKeys(content);
    expect(env.get('CRAFTEDAI_APP_SECRET')).toBe('');
    expect(env.get('CRAFTEDAI_ORG_ID')).toBe('');
    expect(content.match(/^CRAFTEDAI_APP_SECRET=/gm)).toHaveLength(1);
    const printed = out.join('\n');
    expect(printed).toMatch(/skipped CRAFTEDAI_APP_SECRET .*empty/);
    expect(printed).toMatch(/skipped CRAFTEDAI_ORG_ID .*empty/);
  });

  it('writes nothing when every key is already set', async () => {
    const existing = `CRAFTEDAI_SECRET_KEY=${KEY}\nCRAFTEDAI_APP_SECRET=${'a'.repeat(43)}\nCRAFTEDAI_ORG_ID=org-1\n`;
    const { io, appends } = fakeIo({ '/app/.env': existing });
    expect(await runInit(io)).toBe(0);
    expect(appends).toEqual([]);
  });

  it('generates one app secret and never CRAFTEDAI_APP_SECRET_PREVIOUS (rotation is by hand)', async () => {
    let generated = 0;
    const { io, fs } = fakeIo(
      {},
      { randomSecret: () => `only-secret-${(generated += 1)}-${'x'.repeat(30)}` },
    );
    await runInit(io);
    expect(generated).toBe(1);
    expect(parseEnvKeys(fs.get('/app/.env') ?? '').has('CRAFTEDAI_APP_SECRET_PREVIOUS')).toBe(
      false,
    );

    const existing = `CRAFTEDAI_APP_SECRET_PREVIOUS=${'p'.repeat(43)}\n`;
    const again = fakeIo({ '/app/.env': existing });
    await runInit(again.io);
    const content = again.fs.get('/app/.env') ?? '';
    expect(content.startsWith(existing)).toBe(true);
    expect(content.match(/^CRAFTEDAI_APP_SECRET_PREVIOUS=/gm)).toHaveLength(1);
  });

  it('generates a base64url app secret of 32 random bytes that the client accepts', async () => {
    const written: string[] = [];
    for (let run = 0; run < 2; run += 1) {
      const { io, fs } = fakeIo({}, { randomSecret: undefined });
      await runInit(io);
      const secret = parseEnvKeys(fs.get('/app/.env') ?? '').get('CRAFTEDAI_APP_SECRET') ?? '';
      expect(secret).toMatch(APP_SECRET_RE);
      expect(Buffer.from(secret, 'base64url')).toHaveLength(32);
      written.push(secret);
    }
    expect(written[0]).not.toBe(written[1]);
  });

  describe('refuses to write material that is public', () => {
    const published = vectors.config.appSecret;

    it('a published test-vector app secret', async () => {
      const { io, fs, appends } = fakeIo({}, { randomSecret: () => published });
      await expect(runInit(io)).rejects.toThrow(/test-vector/);
      expect(fs.has('/app/.env')).toBe(false);
      expect(appends).toEqual([]);
    });

    it('an app secret that is too short to be 32 bytes', async () => {
      const { io, fs } = fakeIo({}, { randomSecret: () => 'short' });
      await expect(runInit(io)).rejects.toThrow(/32 random bytes/);
      expect(fs.has('/app/.env')).toBe(false);
    });

    it('a published value coming back as the org id', async () => {
      const { io, fs } = fakeIo({}, { fetch: answering(200, { ...KEY_INFO, orgId: published }) });
      await expect(runInit(io)).rejects.toThrow(/published test/);
      expect(fs.has('/app/.env')).toBe(false);
    });
  });

  it('warns when the existing org id belongs to another organization', async () => {
    const { io, out } = fakeIo({ '/app/.env': 'CRAFTEDAI_ORG_ID=org-other\n' });
    await runInit(io);
    expect(out.join('\n')).toMatch(/WARNING: .*org-other.*org-1/);
  });

  it('warns when .env holds a different server key than the one it checked, without printing either', async () => {
    const other = `cai_${'z'.repeat(43)}`;
    const { io, out, fs } = fakeIo({ '/app/.env': `CRAFTEDAI_SECRET_KEY=${other}\n` });
    // The environment wins as the key to check; .env keeps its own value.
    await runInit(io);
    const printed = out.join('\n');
    expect(printed).toMatch(/WARNING: .*CRAFTEDAI_SECRET_KEY/);
    expect(printed).not.toContain(KEY);
    expect(printed).not.toContain(other);
    expect(fs.get('/app/.env')).toContain(`CRAFTEDAI_SECRET_KEY=${other}`);
  });

  it('warns when an existing app secret is not usable, without printing it', async () => {
    const { io, out } = fakeIo({ '/app/.env': 'CRAFTEDAI_APP_SECRET=too-short\n' });
    await runInit(io);
    const printed = out.join('\n');
    expect(printed).toMatch(/WARNING: .*CRAFTEDAI_APP_SECRET.*32 random bytes/);
    expect(printed).not.toContain('too-short');
  });

  it('writes the staging origins only when key-info is not production', async () => {
    const { io, fs } = fakeIo(
      {},
      {
        fetch: answering(200, {
          ...KEY_INFO,
          apiOrigin: 'https://api.staging.craftedai.co',
          chatOrigin: 'https://chat.staging.craftedai.co',
        }),
      },
    );
    await runInit(io);
    const env = parseEnvKeys(fs.get('/app/.env') ?? '');
    expect(env.get('CRAFTEDAI_API_ORIGIN')).toBe('https://api.staging.craftedai.co');
    expect(env.get('CRAFTEDAI_CHAT_ORIGIN')).toBe('https://chat.staging.craftedai.co');
  });

  it('prints the CSP and widget for the chat origin key-info returned', async () => {
    const { io, out } = fakeIo(
      {},
      { fetch: answering(200, { ...KEY_INFO, chatOrigin: 'https://chat.staging.craftedai.co' }) },
    );
    await runInit(io);
    const printed = out.join('\n');
    expect(printed).toContain('src="https://chat.staging.craftedai.co/widget.js"');
    expect(printed).toContain(
      'script-src https://chat.staging.craftedai.co; frame-src https://chat.staging.craftedai.co;',
    );
  });

  it('warns when .env pins an origin other than the one the key belongs to', async () => {
    const { io, out } = fakeIo({
      '/app/.env': 'CRAFTEDAI_API_ORIGIN=https://api.staging.craftedai.co\n',
    });
    await runInit(io);
    expect(out.join('\n')).toMatch(/WARNING: .*CRAFTEDAI_API_ORIGIN.*staging.*craftedai\.co/);
  });

  describe('the key-info call', () => {
    it('GETs {apiOrigin}/portal/v1/key-info with the key as a Bearer token and refuses redirects', async () => {
      const { io, calls } = fakeIo({});
      await runInit(io);
      expect(calls).toHaveLength(1);
      const [call] = calls;
      expect(call!.url).toBe('https://api.craftedai.co/portal/v1/key-info');
      expect(call!.init.redirect).toBe('error');
      expect(call!.init.method ?? 'GET').toBe('GET');
      expect(call!.init.body ?? null).toBeNull();
      expect(new Headers(call!.init.headers).get('authorization')).toBe(`Bearer ${KEY}`);
      expect(call!.url).not.toContain(KEY);
      expect(call!.url).not.toContain('cai_');
    });

    it('uses --api-origin, then CRAFTEDAI_API_ORIGIN, then the one in .env', async () => {
      const flagged = fakeIo({}, { args: ['--api-origin', 'http://localhost:4000'] });
      await runInit(flagged.io);
      expect(flagged.calls[0]!.url).toBe('http://localhost:4000/portal/v1/key-info');

      const equals = fakeIo({}, { args: ['--api-origin=http://localhost:4001'] });
      await runInit(equals.io);
      expect(equals.calls[0]!.url).toBe('http://localhost:4001/portal/v1/key-info');

      const fromEnv = fakeIo(
        { '/app/.env': 'CRAFTEDAI_API_ORIGIN=https://from-file.example\n' },
        { env: { CRAFTEDAI_SECRET_KEY: KEY, CRAFTEDAI_API_ORIGIN: 'https://from-env.example' } },
      );
      await runInit(fromEnv.io);
      expect(fromEnv.calls[0]!.url).toBe('https://from-env.example/portal/v1/key-info');

      const fromFile = fakeIo({ '/app/.env': 'CRAFTEDAI_API_ORIGIN=https://from-file.example\n' });
      await runInit(fromFile.io);
      expect(fromFile.calls[0]!.url).toBe('https://from-file.example/portal/v1/key-info');
    });

    it('refuses an api origin that is not a bare https origin, before sending the key', async () => {
      const { io, calls } = fakeIo({}, { args: ['--api-origin', 'http://api.example.com'] });
      await expect(runInit(io)).rejects.toThrow(/https/);
      expect(calls).toEqual([]);
    });

    it('a refused key writes nothing, and the error never carries the key', async () => {
      const { io, fs, out } = fakeIo(
        {},
        { fetch: answering(401, { error: 'invalid_credentials' }) },
      );
      const failure = await runInit(io).catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(InitError);
      expect((failure as Error).message).toMatch(/refused that key/);
      expect((failure as Error).message).not.toContain(KEY);
      expect(fs.has('/app/.env')).toBe(false);
      expect(out.join('\n')).not.toContain(KEY);
    });

    it('explains a 503 onboarding_not_configured', async () => {
      const { io, fs } = fakeIo(
        {},
        { fetch: answering(503, { error: 'onboarding_not_configured' }) },
      );
      await expect(runInit(io)).rejects.toThrow(/not set up for onboarding/);
      expect(fs.has('/app/.env')).toBe(false);
    });

    it.each([500, 404])('says what a %i answer was without echoing the body', async (status) => {
      const { io, fs } = fakeIo({}, { fetch: answering(status, { error: `leak-${KEY}` }) });
      const failure = await runInit(io).catch((error: unknown) => error as Error);
      expect((failure as Error).message).toContain(String(status));
      expect((failure as Error).message).not.toContain(KEY);
      expect(fs.has('/app/.env')).toBe(false);
    });

    it('reports an unreachable api (network error or refused redirect) without the error text', async () => {
      const { io, fs } = fakeIo(
        {},
        {
          fetch: (() =>
            Promise.reject(new TypeError(`fetch failed for ${KEY}`))) as unknown as typeof fetch,
        },
      );
      const failure = await runInit(io).catch((error: unknown) => error as Error);
      expect((failure as Error).message).toMatch(/could not reach https:\/\/api\.craftedai\.co/);
      expect((failure as Error).message).not.toContain(KEY);
      expect(fs.has('/app/.env')).toBe(false);
    });

    it.each([
      ['not an object', 'nope'],
      ['no org id', { ...KEY_INFO, orgId: '' }],
      ['an org id that is not a plain id', { ...KEY_INFO, orgId: 'org-1\nINJECTED=1' }],
      ['agents missing', { ...KEY_INFO, agents: undefined }],
      ['an api origin with a path', { ...KEY_INFO, apiOrigin: 'https://api.craftedai.co/v1' }],
      ['a chat origin over http', { ...KEY_INFO, chatOrigin: 'http://chat.craftedai.co' }],
    ])('refuses a key-info with %s and writes nothing', async (_name, body) => {
      const { io, fs } = fakeIo({}, { fetch: answering(200, body) });
      await expect(runInit(io)).rejects.toThrow(/key-info/);
      expect(fs.has('/app/.env')).toBe(false);
    });
  });

  describe('the secret key', () => {
    it('prompts hidden when none is available', async () => {
      let asked: { secret: boolean } | undefined;
      const { io, fs } = fakeIo(
        {},
        {
          env: {},
          prompt: (_q, o) => ((asked = o), Promise.resolve(`  ${KEY}\n`)),
        },
      );
      await runInit(io);
      expect(asked).toEqual({ secret: true });
      expect(parseEnvKeys(fs.get('/app/.env') ?? '').get('CRAFTEDAI_SECRET_KEY')).toBe(KEY);
    });

    it('does not prompt when .env already holds a key, and treats an empty one as absent', async () => {
      const held = fakeIo({ '/app/.env': `CRAFTEDAI_SECRET_KEY="${KEY}"\n` }, { env: {} });
      await runInit(held.io);
      expect(held.calls).toHaveLength(1);

      let asked = 0;
      const empty = fakeIo(
        { '/app/.env': 'CRAFTEDAI_SECRET_KEY=\n' },
        { env: { CRAFTEDAI_SECRET_KEY: '  ' }, prompt: () => ((asked += 1), Promise.resolve(KEY)) },
      );
      await runInit(empty.io);
      expect(asked).toBe(1);
    });

    it('refuses --key / --key=… on the command line: argv is visible to other users and in history', async () => {
      for (const args of [['--key', KEY], [`--key=${KEY}`]]) {
        const { io, calls, fs } = fakeIo({}, { args });
        const failure = await runInit(io).catch((error: unknown) => error as Error);
        expect(failure).toBeInstanceOf(InitError);
        expect((failure as Error).message).toMatch(
          /not accepted on the command line.*CRAFTEDAI_SECRET_KEY/,
        );
        expect((failure as Error).message).not.toContain(KEY);
        expect(calls).toEqual([]);
        expect(fs.has('/app/.env')).toBe(false);
      }
    });

    it('refuses an unknown argument without echoing it (it could be a pasted key)', async () => {
      const { io, calls } = fakeIo({}, { args: [KEY] });
      const failure = await runInit(io).catch((error: unknown) => error as Error);
      expect(failure).toBeInstanceOf(InitError);
      expect((failure as Error).message).not.toContain(KEY);
      expect(calls).toEqual([]);
    });

    it('refuses a value that is not a cai_ key, without echoing it', async () => {
      const { io, calls } = fakeIo({}, { env: { CRAFTEDAI_SECRET_KEY: 'sk-live-not-ours' } });
      const failure = await runInit(io).catch((error: unknown) => error as Error);
      expect((failure as Error).message).toMatch(/cai_/);
      expect((failure as Error).message).not.toContain('sk-live');
      expect(calls).toEqual([]);
    });

    it('never puts the key, or any piece of it, in a printed line or a URL', async () => {
      const distinct = `cai_${'0Zx9Kq4Wm2Lp7Vb3Nc8Rt5Hy1Gd6Sj0FaE9XuI'}`;
      const viaPrompt = fakeIo({}, { env: {}, prompt: () => Promise.resolve(distinct) });
      await runInit(viaPrompt.io);
      const viaEnv = fakeIo({}, { env: { CRAFTEDAI_SECRET_KEY: distinct } });
      await runInit(viaEnv.io);
      const skipped = fakeIo({ '/app/.env': `CRAFTEDAI_SECRET_KEY=${distinct}\n` }, { env: {} });
      await runInit(skipped.io);
      const body = distinct.slice('cai_'.length);
      const pieces = Array.from({ length: body.length - 3 }, (_, i) => body.slice(i, i + 4));
      for (const run of [viaPrompt, viaEnv, skipped]) {
        expect(run.out.length).toBeGreaterThan(5);
        for (const piece of pieces) {
          for (const line of run.out) expect(line).not.toContain(piece);
          for (const call of run.calls) expect(call.url).not.toContain(piece);
        }
      }
    });
  });

  it('--env-file picks the file that is read and written', async () => {
    const { io, fs } = fakeIo({}, { args: ['--env-file', '.env.local'] });
    await runInit(io);
    expect(fs.has('/app/.env')).toBe(false);
    expect(parseEnvKeys(fs.get('/app/.env.local') ?? '').get('CRAFTEDAI_ORG_ID')).toBe('org-1');
  });

  describe('.gitignore', () => {
    it.each(['.env', '/.env', '.env*', '.env.*', '.env\r\n', 'node_modules\n.env\n'])(
      'is satisfied by %j',
      async (gitignore) => {
        const { io, out } = fakeIo({ '/app/.gitignore': gitignore });
        await runInit(io);
        expect(out.join('\n')).not.toContain('gitignore');
      },
    );

    it.each([
      ['no .gitignore', undefined],
      ['one without .env', 'node_modules\n'],
    ])('warns with %s', async (_name, gitignore) => {
      const { io, out } = fakeIo(gitignore === undefined ? {} : { '/app/.gitignore': gitignore });
      await runInit(io);
      expect(out.join('\n')).toMatch(/WARNING: .*\.env.*\.gitignore/);
    });
  });

  it('prints the agents of the key, and a hint when it has none', async () => {
    const many = fakeIo(
      {},
      {
        fetch: answering(200, {
          ...KEY_INFO,
          agents: [
            { id: 'agent-1', name: 'Support' },
            { id: 'agent-2', name: 'Sales\u001b[31m' },
          ],
        }),
      },
    );
    await runInit(many.io);
    const printed = many.out.join('\n');
    expect(printed).toContain('data-agent="agent-1"');
    expect(printed).toContain('Sales');
    expect(printed).toContain('agent-2');
    expect(printed).not.toContain('\u001b');

    const none = fakeIo({}, { fetch: answering(200, { ...KEY_INFO, agents: [] }) });
    await runInit(none.io);
    expect(none.out.join('\n')).toMatch(/cannot mint for any agent/);
  });

  it('drops an agent whose id is not a plain id instead of printing it into the tag', async () => {
    const { io, out } = fakeIo(
      {},
      {
        fetch: answering(200, {
          ...KEY_INFO,
          agents: [{ id: 'a"><script>', name: 'Evil' }],
        }),
      },
    );
    await runInit(io);
    expect(out.join('\n')).not.toContain('<script>');
  });
});
