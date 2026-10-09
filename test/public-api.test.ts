import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
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
});
