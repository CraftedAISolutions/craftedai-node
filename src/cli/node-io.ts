import { appendFile, readFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';
import { Writable as WritableStream } from 'node:stream';
import { InitError, type InitIo } from './init.js';

/** The file's text; null when it does not exist. Any other failure is an error, never "empty". */
export async function readTextFile(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new InitError(`could not read ${path}`);
  }
}

/**
 * Appends to the file. `mode` only applies when the call creates the file, so a new `.env` is
 * 0600 (owner only) and an existing one keeps whatever mode its owner gave it.
 */
export async function appendTextFile(path: string, text: string): Promise<void> {
  try {
    await appendFile(path, text, { mode: 0o600 });
  } catch {
    throw new InitError(`could not write ${path}`);
  }
}

export interface PromptStreams {
  input: Readable;
  output: Writable;
  /** Defaults to whether `input` is a TTY. Readline echoes typed characters only in terminal mode. */
  terminal?: boolean;
}

/**
 * Asks one question. With `secret`, whatever is typed is never written to `output`: readline
 * echoes into a sink that is muted once the question has been shown.
 */
export function ask(
  question: string,
  options: { secret: boolean },
  streams: PromptStreams,
): Promise<string> {
  const { input, output } = streams;
  output.write(question);
  let muted = false;
  const sink = new WritableStream({
    write(chunk: Buffer, _encoding, callback) {
      if (!(muted && options.secret)) output.write(chunk);
      callback();
    },
  });
  const terminal = streams.terminal ?? (input as { isTTY?: boolean }).isTTY === true;
  const lines = createInterface({ input, output: sink, terminal });
  return new Promise<string>((resolve, reject) => {
    let answered = false;
    lines.once('close', () => {
      if (!answered) reject(new InitError('no answer was given'));
    });
    lines.once('SIGINT', () => {
      lines.close();
    });
    muted = true;
    lines.question('', (answer) => {
      answered = true;
      lines.close();
      output.write('\n');
      resolve(answer);
    });
  });
}

/** The real process: cwd, env, `.env` on disk, global fetch, stdout. */
export function createNodeIo(args: readonly string[]): InitIo {
  return {
    cwd: process.cwd(),
    env: process.env,
    args,
    readFile: readTextFile,
    appendFile: appendTextFile,
    prompt: (question, options) =>
      ask(question, options, { input: process.stdin, output: process.stdout }),
    fetch: (input, init) => globalThis.fetch(input, init),
    print: (line) => console.log(line),
  };
}
