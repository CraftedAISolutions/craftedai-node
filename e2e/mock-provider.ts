import { createServer, type Server } from 'node:http';

/**
 * OpenAI-compatible model double for the e2e (the org model's `baseUrl`).
 * Turn 1 (no tool result yet): asks for `get_order_status`. Turn 2 (a `tool`
 * message present): answers with text quoting the tool result. Streams when
 * asked to, since the portal turn path streams.
 */
interface ChatBody {
  stream?: boolean;
  messages?: { role: string; content?: unknown }[];
  tools?: { function?: { name?: string } }[];
}

/**
 * core-api advertises each MCP tool under its own (prefixed) name, so the double asks for the
 * advertised name that ends in `get_order_status`, not the bare MCP tool name.
 */
function toolCall(body: ChatBody) {
  const advertised = body.tools
    ?.map((tool) => tool.function?.name)
    .find((name) => name?.endsWith('get_order_status'));
  return {
    id: 'call_e2e_1',
    type: 'function',
    function: { name: advertised ?? 'get_order_status', arguments: '{}' },
  };
}

function chunk(delta: Record<string, unknown>, finish: string | null): string {
  return `data: ${JSON.stringify({
    id: 'chatcmpl-e2e',
    object: 'chat.completion.chunk',
    created: 0,
    model: 'e2e',
    choices: [{ index: 0, delta, finish_reason: finish }],
  })}\n\n`;
}

export function startMockProvider(port: number): Promise<Server> {
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c: Buffer) => (raw += c.toString()));
    req.on('end', () => {
      const body = JSON.parse(raw || '{}') as ChatBody;
      const toolResult = body.messages?.find((m) => m.role === 'tool');
      const text = toolResult ? `Your order: ${JSON.stringify(toolResult.content)}` : null;
      if (body.stream === true) {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        if (text === null) {
          res.write(
            chunk({ role: 'assistant', tool_calls: [{ index: 0, ...toolCall(body) }] }, null),
          );
          res.write(chunk({}, 'tool_calls'));
        } else {
          res.write(chunk({ role: 'assistant', content: text }, null));
          res.write(chunk({}, 'stop'));
        }
        res.end('data: [DONE]\n\n');
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          id: 'chatcmpl-e2e',
          object: 'chat.completion',
          created: 0,
          model: 'e2e',
          choices: [
            {
              index: 0,
              message:
                text === null
                  ? { role: 'assistant', content: null, tool_calls: [toolCall(body)] }
                  : { role: 'assistant', content: text },
              finish_reason: text === null ? 'tool_calls' : 'stop',
            },
          ],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        }),
      );
    });
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)));
}
