import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { builtinModules, createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { printed } from './helpers/printed.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const INTERNALS = ['allowTestVectorKeys', 'maxStalenessMs', 'JwksCache', 'JwksCacheOptions'];

describe('public type surface (review correction 5)', () => {
  let outDir: string;
  let declarations: string;

  beforeAll(() => {
    // Build the real bundles into a throwaway directory, exactly as `npm run build` does. It lives
    // under the repo's node_modules so the built files can resolve `jose` like an installed package.
    const cache = join(root, 'node_modules', '.cache');
    mkdirSync(cache, { recursive: true });
    outDir = mkdtempSync(join(cache, 'craftedai-build-'));
    execFileSync('npx', ['tsup', '--out-dir', outDir], { cwd: root, stdio: 'pipe' });
    declarations = readdirSync(outDir)
      .filter((file) => file.endsWith('.d.ts') || file.endsWith('.d.cts'))
      .map((file) => readFileSync(join(outDir, file), 'utf8'))
      .join('\n');
  }, 120_000);

  afterAll(() => {
    rmSync(outDir, { recursive: true, force: true });
  });

  it('builds declarations that include the public client', () => {
    expect(declarations).toContain('class CraftedAI');
    expect(declarations).toContain('interface CraftedAIOptions');
  });

  it.each(INTERNALS)('does not leak the internal %s into the built .d.ts / .d.cts', (name) => {
    expect(declarations).not.toContain(name);
  });

  describe('built bundles do not leak secrets (fix round 1)', () => {
    const SECRET_KEY = `cai_${'k'.repeat(43)}`;
    const APP_SECRET = 'kT3hJ9mQ2vXw7LpRzN5cYb8dFa1GeUo4sIiWnVj6HxA';
    const PREVIOUS = 'Q0hBTkdFLU1FLW9sZC1hcHAtc2VjcmV0LTQzLWNoYXJzLXg';
    type Ctor = new (options: object) => { config: { appSecret?: string } };
    const options = {
      secretKey: SECRET_KEY,
      appSecret: APP_SECRET,
      previousAppSecret: PREVIOUS,
      orgId: '0b6f0c1e-5d6a-4d39-9a51-8f0e5c3b2a10',
      env: {},
    };

    async function loadBuilt(format: 'esm' | 'cjs'): Promise<Ctor> {
      if (format === 'esm') {
        const mod = (await import(
          /* @vite-ignore */ pathToFileURL(join(outDir, 'index.js')).href
        )) as {
          CraftedAI: Ctor;
        };
        return mod.CraftedAI;
      }
      return (createRequire(import.meta.url)(join(outDir, 'index.cjs')) as { CraftedAI: Ctor })
        .CraftedAI;
    }

    it.each(['esm', 'cjs'] as const)(
      '%s build: no printed form contains a secret',
      async (format) => {
        const client = new (await loadBuilt(format))(options);
        expect(client.config.appSecret).toBe(APP_SECRET);
        for (const [how, text] of Object.entries(printed(client))) {
          for (const secret of [SECRET_KEY, APP_SECRET, PREVIOUS]) {
            expect(text, `${format}: ${how}`).not.toContain(secret);
          }
        }
      },
    );
  });
  describe('the craftedai bin (npx craftedai init)', () => {
    const KEY = `cai_${'k'.repeat(43)}`;
    const run = (args: string[], input = '') => {
      // A throwaway cwd with an empty environment: no real .env, key or network is involved.
      const cwd = mkdtempSync(join(tmpdir(), 'craftedai-bin-'));
      try {
        return {
          ...spawnSync(process.execPath, [join(outDir, 'cli.js'), ...args], {
            cwd,
            input,
            env: { PATH: process.env.PATH ?? '' },
            encoding: 'utf8',
          }),
          cwd,
        };
      } finally {
        rmSync(cwd, { recursive: true, force: true });
      }
    };

    it('starts with a node shebang and is executable', () => {
      const file = join(outDir, 'cli.js');
      expect(readFileSync(file, 'utf8').startsWith('#!/usr/bin/env node\n')).toBe(true);
      if (process.platform !== 'win32') expect(statSync(file).mode & 0o111).toBe(0o111);
    });

    it('imports only node built-ins: nothing has to resolve before it can run', () => {
      const source = readFileSync(join(outDir, 'cli.js'), 'utf8');
      const imports = [...source.matchAll(/^import (?:[^\n]* from )?"([^"]+)";$/gm)];
      expect(imports.length).toBeGreaterThan(0);
      for (const [, specifier] of imports) {
        expect(builtinModules).toContain(specifier!.replace(/^node:/, ''));
      }
    });

    it('prints usage for --help and for init --help, exit 0', () => {
      for (const args of [['--help'], ['init', '--help'], []]) {
        const result = run(args);
        expect(result.status).toBe(0);
        expect(result.stdout).toContain('Usage: npx craftedai init');
      }
    });

    it('exits 1 on an unknown command', () => {
      expect(run(['nope']).status).toBe(1);
    });

    it('refuses the key on the command line and does not echo it', () => {
      const result = run(['init', '--key', KEY]);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('craftedai init: the server key is not accepted');
      expect(result.stdout + result.stderr).not.toContain(KEY);
    });

    it('exits 1 when there is no key and nothing to read one from', () => {
      const result = run(['init']);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('craftedai init: no answer was given');
    });

    it('does not echo a key that is piped in, and refuses it as malformed before any request', () => {
      const result = run(['init'], 'sk-not-a-craftedai-key\n');
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('not a cai_ server key');
      expect(result.stdout + result.stderr).not.toContain('sk-not-a');
    });
  });
});
