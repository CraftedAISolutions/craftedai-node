import { chmod, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { InitError } from './init.js';
import { appendTextFile, ask, readTextFile } from './node-io.js';

describe('the .env file on disk', () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'craftedai-init-'));
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('creates a missing file readable and writable by its owner only (0600)', async () => {
    const path = join(dir, 'new.env');
    await appendTextFile(path, 'A=1\n');
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(await readFile(path, 'utf8')).toBe('A=1\n');
  });

  it('appends to an existing file and leaves its mode alone', async () => {
    const path = join(dir, 'existing.env');
    await writeFile(path, 'KEEP=1\n');
    await chmod(path, 0o644);
    await appendTextFile(path, 'ADD=2\n');
    expect((await stat(path)).mode & 0o777).toBe(0o644);
    expect(await readFile(path, 'utf8')).toBe('KEEP=1\nADD=2\n');
  });

  it('reads a missing file as null but fails on any other read error', async () => {
    expect(await readTextFile(join(dir, 'absent.env'))).toBeNull();
    expect(await readTextFile(join(dir, 'new.env'))).toBe('A=1\n');
    // A directory is not "no file": treating it as empty would hide a real problem.
    await expect(readTextFile(dir)).rejects.toBeInstanceOf(InitError);
  });

  it('reports a write failure as an InitError that names the path only', async () => {
    const path = join(dir, 'no-such-dir', 'x.env');
    const failure = await appendTextFile(path, 'A=1\n').catch((error: unknown) => error as Error);
    expect(failure).toBeInstanceOf(InitError);
    expect((failure as Error).message).toBe(`could not write ${path}`);
  });
});

describe('ask', () => {
  function streams(terminal: boolean) {
    const input = new PassThrough();
    const output = new PassThrough();
    const shown: string[] = [];
    output.on('data', (chunk: Buffer) => shown.push(chunk.toString('utf8')));
    return { input, output, terminal, shown };
  }
  const tick = () => new Promise((resolve) => setTimeout(resolve, 20));

  it('does not echo a secret answer', async () => {
    const s = streams(true);
    const answer = ask('Key: ', { secret: true }, s);
    await tick();
    s.input.write('cai_typed-secret-value\n');
    expect(await answer).toBe('cai_typed-secret-value');
    const shown = s.shown.join('');
    expect(shown).toContain('Key: ');
    expect(shown).not.toContain('cai_typed');
    expect(shown).not.toContain('typed-secret');
  });

  it('echoes a non-secret answer (the mute is what hides the secret)', async () => {
    const s = streams(true);
    const answer = ask('Name: ', { secret: false }, s);
    await tick();
    s.input.write('visible-name\n');
    expect(await answer).toBe('visible-name');
    expect(s.shown.join('')).toContain('visible-name');
  });

  it('reads a piped answer (no terminal) without echoing it', async () => {
    const s = streams(false);
    const answer = ask('Key: ', { secret: true }, s);
    s.input.end('cai_piped\n');
    expect(await answer).toBe('cai_piped');
    expect(s.shown.join('')).not.toContain('cai_piped');
  });

  it('rejects when the input ends without an answer', async () => {
    const s = streams(false);
    const answer = ask('Key: ', { secret: true }, s);
    s.input.end();
    await expect(answer).rejects.toThrow(InitError);
  });

  it('rejects on Ctrl-C', async () => {
    const s = streams(true);
    const answer = ask('Key: ', { secret: true }, s);
    await tick();
    s.input.write('\u0003');
    await expect(answer).rejects.toThrow(InitError);
  });
});
