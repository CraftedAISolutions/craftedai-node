import { inspect } from 'node:util';

/** Everything a logger, a serializer or a debugger might do with a client. */
export function printed(client: unknown): Record<string, string> {
  const config = (client as { config: object }).config;
  return {
    'JSON.stringify(client)': JSON.stringify(client),
    'util.inspect(client, depth 10)': inspect(client, { depth: 10 }),
    'util.inspect(client, showHidden)': inspect(client, { depth: 10, showHidden: true }),
    'String(client)': String(client),
    'JSON.stringify(client.config)': JSON.stringify(config),
    'util.inspect(client.config)': inspect(config, { depth: 10 }),
    'spread client.config': JSON.stringify({ ...config }),
  };
}
