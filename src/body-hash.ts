import { createHash } from 'node:crypto';

/** base64url(SHA-256(raw body bytes)); an absent body hashes the empty string (`EMPTY_BODY_HASH`). */
export function bodyHash(body: Uint8Array | null): string {
  return createHash('sha256')
    .update(body ?? new Uint8Array())
    .digest('base64url');
}
