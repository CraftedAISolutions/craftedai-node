import { CraftedAIError } from '../errors.js';

/** Largest body the guards read when the caller does not say (1 MiB; MCP JSON-RPC bodies are far smaller). */
export const MAX_BODY_BYTES = 1024 * 1024;
/** The session route's body is `{ "agentId": "<uuid>" }`; this is generous. */
export const SESSION_BODY_MAX_BYTES = 16 * 1024;

/**
 * The audience URL is `protocol://host/path` exactly as the framework sees the request, with
 * NO query string and NO fragment: core-api's `aud` is the endpoint URL stored for the MCP,
 * which has neither. The verifier compares it with the token's `aud`
 * as an exact string (the shared test vectors pin that: capitals in the host or an explicit
 * default port do not match). `X-Forwarded-*` and `Forwarded` are never read by the adapters; a server
 * behind a proxy sets `publicUrl` (or Express's `trust proxy` / Fastify's `trustProxy`, which
 * change what the framework itself reports).
 */
export function stripQuery(target: string): string {
  const cut = target.search(/[?#]/);
  return cut === -1 ? target : target.slice(0, cut);
}

export function audienceUrl(protocol: string, host: string, target: string): string {
  return `${protocol}://${host}${stripQuery(target)}`;
}

export function assertMaxBodyBytes(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new CraftedAIError('config_invalid', 'maxBodyBytes must be a positive whole number');
  }
}
