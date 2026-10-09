import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('..', import.meta.url));
const INTERNALS = ['allowTestVectorKeys', 'maxStalenessMs', 'JwksCache', 'JwksCacheOptions'];

describe('public type surface (review correction 5)', () => {
  let outDir: string;
  let declarations: string;

  beforeAll(() => {
    // Build the real declaration files into a throwaway directory, exactly as `npm run build` does.
    outDir = mkdtempSync(join(tmpdir(), 'craftedai-dts-'));
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
});
