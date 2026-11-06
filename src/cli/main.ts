import { CraftedAIError } from '../errors.js';
import { InitError, runInit, USAGE } from './init.js';
import { createNodeIo } from './node-io.js';

async function main(argv: readonly string[]): Promise<number> {
  const [command, ...args] = argv;
  const wantsHelp =
    command === undefined || [command, ...args].some((a) => a === '--help' || a === '-h');
  if (wantsHelp || command !== 'init') {
    console.log(USAGE);
    return wantsHelp ? 0 : 1;
  }
  return runInit(createNodeIo(args));
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    // Only messages written for the screen are shown; anything else could quote a request.
    const known = error instanceof InitError || error instanceof CraftedAIError;
    console.error(`craftedai init: ${known ? error.message : 'unexpected error'}`);
    process.exitCode = 1;
  },
);
