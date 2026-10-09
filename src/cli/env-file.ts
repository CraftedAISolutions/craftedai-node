/**
 * `.env` merge for `npx craftedai init` (spec §8, §12.4): append-only. An existing
 * assignment is never rewritten, and neither is an empty one (library Ruling 11: an
 * empty value is a choice the developer made, not a gap to fill). The caller reports
 * each of them as skipped. The original bytes are kept; the result only ever grows
 * by a suffix.
 */
export interface EnvEntry {
  key: string;
  value: string;
  comment: string;
}

export interface EnvMergeResult {
  content: string;
  written: string[];
  skipped: { key: string; existing: string }[];
}

const ASSIGNMENT_RE = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/;
const KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const BLOCK_HEADER = '# Added by npx craftedai init';

/** A quoted value is what is inside the quotes; an unquoted one loses its trailing ` # comment`. */
function parseValue(raw: string): string {
  const value = raw.trim();
  const quote = value[0];
  if (quote === '"' || quote === "'") {
    const end = value.indexOf(quote, 1);
    if (end !== -1) return value.slice(1, end);
  }
  return value.replace(/(^|\s)#.*$/, '').trim();
}

/** Existing assignments, last one wins (as dotenv does). Values are unquoted, never interpolated. */
export function parseEnvKeys(content: string): Map<string, string> {
  const keys = new Map<string, string>();
  for (const line of content.split(/\r?\n/)) {
    const match = ASSIGNMENT_RE.exec(line);
    if (match?.[1] === undefined) continue;
    keys.set(match[1], parseValue(match[2] ?? ''));
  }
  return keys;
}

/** The file's own line ending, decided by its first line break (LF for an empty file). */
function lineEnding(content: string): '\n' | '\r\n' {
  const firstBreak = content.indexOf('\n');
  return firstBreak > 0 && content[firstBreak - 1] === '\r' ? '\r\n' : '\n';
}

function assertEntry(entry: EnvEntry): void {
  if (!KEY_RE.test(entry.key)) throw new Error('env key is not a valid variable name');
  if (/[\r\n\0]/.test(entry.value) || /[\r\n\0]/.test(entry.comment)) {
    throw new Error(`${entry.key}: a value and its comment must fit on a single line`);
  }
}

export function mergeEnv(existing: string, entries: readonly EnvEntry[]): EnvMergeResult {
  const present = parseEnvKeys(existing);
  const eol = lineEnding(existing);
  const written: string[] = [];
  const skipped: { key: string; existing: string }[] = [];
  const lines: string[] = [];
  for (const entry of entries) {
    assertEntry(entry);
    const current = present.get(entry.key);
    if (current !== undefined) {
      skipped.push({ key: entry.key, existing: current });
      continue;
    }
    lines.push(`# ${entry.comment}`, `${entry.key}=${entry.value}`);
    written.push(entry.key);
  }
  if (lines.length === 0) return { content: existing, written, skipped };
  let separator = '';
  if (existing !== '') {
    if (/\n\r?\n$/.test(existing)) separator = '';
    else if (existing.endsWith('\n')) separator = eol;
    else separator = eol + eol;
  }
  return {
    content: `${existing}${separator}${[BLOCK_HEADER, ...lines].join(eol)}${eol}`,
    written,
    skipped,
  };
}
