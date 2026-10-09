import { describe, expect, it } from 'vitest';
import { mergeEnv, parseEnvKeys } from './env-file.js';

const ENTRIES = [
  { key: 'CRAFTEDAI_SECRET_KEY', value: 'cai_new', comment: 'key' },
  { key: 'CRAFTEDAI_APP_SECRET', value: 'new-secret', comment: 'secret' },
];

describe('parseEnvKeys', () => {
  it('reads plain, quoted, exported, spaced and empty assignments; the last one wins', () => {
    const content = [
      'A=1',
      'B="two words"',
      "C='single'",
      'export D=4',
      '  E = 5  ',
      'F=',
      'G=""',
      'A=last',
    ].join('\n');
    expect([...parseEnvKeys(content)]).toEqual([
      ['A', 'last'],
      ['B', 'two words'],
      ['C', 'single'],
      ['D', '4'],
      ['E', '5'],
      ['F', ''],
      ['G', ''],
    ]);
  });

  it('ignores comment lines and strips an inline comment from an unquoted value', () => {
    const parsed = parseEnvKeys('# A=1\n  # B=2\nC=3 # three\nD="x # y"\nE= # nothing\n');
    expect([...parsed]).toEqual([
      ['C', '3'],
      ['D', 'x # y'],
      ['E', ''],
    ]);
  });

  it('reads CRLF files without a stray carriage return in the value', () => {
    expect(parseEnvKeys('A=1\r\nB="2"\r\n').get('A')).toBe('1');
    expect(parseEnvKeys('A=1\r\nB="2"\r\n').get('B')).toBe('2');
  });
});

describe('mergeEnv (spec §12.4)', () => {
  it('creates the block in an empty file', () => {
    expect(mergeEnv('', ENTRIES)).toEqual({
      content:
        '# Added by npx craftedai init\n# key\nCRAFTEDAI_SECRET_KEY=cai_new\n# secret\nCRAFTEDAI_APP_SECRET=new-secret\n',
      written: ['CRAFTEDAI_SECRET_KEY', 'CRAFTEDAI_APP_SECRET'],
      skipped: [],
    });
  });

  it('never rewrites an existing value — quoted, exported, or empty', () => {
    const existing = 'PORT=3000\nexport CRAFTEDAI_SECRET_KEY="cai_old"\nCRAFTEDAI_APP_SECRET=\n';
    const result = mergeEnv(existing, ENTRIES);
    expect(result.content).toBe(existing);
    expect(result.written).toEqual([]);
    expect(result.skipped).toEqual([
      { key: 'CRAFTEDAI_SECRET_KEY', existing: 'cai_old' },
      { key: 'CRAFTEDAI_APP_SECRET', existing: '' },
    ]);
  });

  it('skips a key whose value is empty instead of filling it (library Ruling 11)', () => {
    for (const empty of [
      'CRAFTEDAI_APP_SECRET=',
      'CRAFTEDAI_APP_SECRET=""',
      "CRAFTEDAI_APP_SECRET=''",
    ]) {
      const result = mergeEnv(`${empty}\n`, [ENTRIES[1]!]);
      expect(result.content).toBe(`${empty}\n`);
      expect(result.written).toEqual([]);
      expect(result.skipped).toEqual([{ key: 'CRAFTEDAI_APP_SECRET', existing: '' }]);
    }
  });

  it('keeps the original bytes and only appends (file without trailing newline)', () => {
    const existing = 'PORT=3000\r\nDEBUG=1';
    const result = mergeEnv(existing, ENTRIES);
    expect(result.content.startsWith(existing)).toBe(true);
    expect(parseEnvKeys(result.content).get('CRAFTEDAI_APP_SECRET')).toBe('new-secret');
    expect(parseEnvKeys(result.content).get('DEBUG')).toBe('1');
  });

  it('adds a blank line before the block and ends the file with a newline', () => {
    expect(mergeEnv('A=1', [ENTRIES[0]!]).content).toBe(
      'A=1\n\n# Added by npx craftedai init\n# key\nCRAFTEDAI_SECRET_KEY=cai_new\n',
    );
    expect(mergeEnv('A=1\n', [ENTRIES[0]!]).content).toBe(
      'A=1\n\n# Added by npx craftedai init\n# key\nCRAFTEDAI_SECRET_KEY=cai_new\n',
    );
  });

  it('writes CRLF line endings into a CRLF file and LF into an LF file', () => {
    const crlf = mergeEnv('A=1\r\nB=2\r\n', [ENTRIES[0]!]).content;
    expect(crlf).toBe(
      'A=1\r\nB=2\r\n\r\n# Added by npx craftedai init\r\n# key\r\nCRAFTEDAI_SECRET_KEY=cai_new\r\n',
    );
    expect(mergeEnv('A=1\nB=2\n', [ENTRIES[0]!]).content).not.toContain('\r');
    // No trailing newline: the first line ending decides.
    expect(mergeEnv('A=1\r\nB=2', [ENTRIES[0]!]).content).toMatch(/B=2\r\n\r\n# Added/);
  });

  it('is idempotent: a second merge of its own output changes nothing', () => {
    const once = mergeEnv('', ENTRIES).content;
    expect(mergeEnv(once, ENTRIES)).toEqual({
      content: once,
      written: [],
      skipped: ENTRIES.map((e) => ({ key: e.key, existing: e.value })),
    });
  });

  it('ignores commented-out assignments', () => {
    expect(mergeEnv('# CRAFTEDAI_SECRET_KEY=cai_x\n', ENTRIES).written).toContain(
      'CRAFTEDAI_SECRET_KEY',
    );
  });

  it('keeps comments and unrelated lines byte for byte', () => {
    const existing = '# my settings\n\nPORT=3000 # dev port\n   \n';
    const result = mergeEnv(existing, ENTRIES);
    expect(result.content.startsWith(existing)).toBe(true);
  });

  it('refuses a value or comment that would break out of its line', () => {
    expect(() => mergeEnv('', [{ key: 'A', value: 'x\nB=injected', comment: 'c' }])).toThrow(
      /single line/,
    );
    expect(() => mergeEnv('', [{ key: 'A', value: 'x\ry', comment: 'c' }])).toThrow(/single line/);
    expect(() => mergeEnv('', [{ key: 'A', value: 'x', comment: 'c\nB=1' }])).toThrow(
      /single line/,
    );
    expect(() => mergeEnv('', [{ key: 'A B', value: 'x', comment: 'c' }])).toThrow(/key/);
  });
});
