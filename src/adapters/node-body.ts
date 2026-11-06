import type { IncomingMessage, ServerResponse } from 'node:http';
import { MAX_BODY_BYTES } from './audience.js';

export { MAX_BODY_BYTES };

const ignore = (): void => undefined;

export class BodyTooLargeError extends Error {}

export type RawBodyRead = { status: 'read'; body: Uint8Array | null } | { status: 'consumed' };

/**
 * The exact bytes of a Node request, at most `maxBytes` of them. A `rawBody` Buffer kept by an
 * earlier parser (e.g. `express.json({ verify: (req, _res, buf) => { req.rawBody = buf } })`)
 * is used as is; a stream already drained by a parser is reported as `consumed` — the guard
 * then answers `body_mismatch` naming the cause (spec §12.3).
 *
 * Reading stops as soon as the cap is crossed (a declared `Content-Length` over the cap is
 * refused without reading at all), so a hostile client cannot make the process buffer more
 * than `maxBytes`. The rest of an over-long body is drained and discarded.
 */
export function readRawBody(
  req: IncomingMessage & { rawBody?: unknown },
  maxBytes: number = MAX_BODY_BYTES,
): Promise<RawBodyRead> {
  if (req.rawBody instanceof Uint8Array) {
    if (req.rawBody.length > maxBytes) return Promise.reject(new BodyTooLargeError());
    return Promise.resolve({ status: 'read', body: req.rawBody });
  }
  if (req.readableEnded) return Promise.resolve({ status: 'consumed' });
  const declared = Number(req.headers['content-length']);
  if (Number.isFinite(declared) && declared > maxBytes) {
    req.resume();
    return Promise.reject(new BodyTooLargeError());
  }
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const finish = (settle: () => void): void => {
      if (settled) return;
      settled = true;
      req.off('data', onData);
      req.off('end', onEnd);
      req.off('error', onError);
      req.off('close', onClose);
      // A client that aborts while the tail is drained must not raise an unhandled 'error'.
      req.on('error', ignore);
      settle();
    };
    const onData = (chunk: Buffer | string): void => {
      const buffer = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
      size += buffer.length;
      if (size > maxBytes) {
        // Stop buffering; keep draining so the 413 can be written on a live connection.
        chunks.length = 0;
        finish(() => {
          req.resume();
          reject(new BodyTooLargeError());
        });
        return;
      }
      chunks.push(buffer);
    };
    const onEnd = (): void =>
      finish(() => resolve({ status: 'read', body: size === 0 ? null : Buffer.concat(chunks) }));
    const onError = (error: Error): void => finish(() => reject(error));
    const onClose = (): void =>
      finish(() => reject(new Error('the request was closed before its body was read')));
    req.on('data', onData);
    req.on('end', onEnd);
    req.on('error', onError);
    req.on('close', onClose);
  });
}

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.end(JSON.stringify(body));
}

export function headerOf(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name.toLowerCase()];
  return Array.isArray(value) ? value.join(', ') : value;
}

export function isJson(contentType: string | undefined): boolean {
  return contentType?.split(';')[0]?.trim().toLowerCase() === 'application/json';
}

/** JSON body for the handler after verification; undefined when absent or not JSON. */
export function parseJsonBody(body: Uint8Array | null, contentType: string | undefined): unknown {
  if (body === null || !isJson(contentType)) return undefined;
  try {
    return JSON.parse(new TextDecoder().decode(body)) as unknown;
  } catch {
    return undefined;
  }
}

export const CONSUMED_BODY_HINT =
  'the request body was already read by a body parser mounted before verifyRequest(); mount verifyRequest() before express.json() (or keep the raw bytes in req.rawBody)';
