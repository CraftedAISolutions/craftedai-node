/** Returned by `readCappedBody` when the body is over the cap. */
export const TOO_LARGE = Symbol('too_large');

/**
 * The bytes of a fetch `Request` body, at most `maxBytes` of them, read from a clone so the
 * original stays readable. A declared `Content-Length` over the cap is refused without reading
 * anything; otherwise reading stops as soon as the streamed total crosses the cap, so a hostile
 * client cannot make the process buffer more than `maxBytes` (plus one chunk).
 *
 * `null` when the request has no body, `TOO_LARGE` past the cap. The caller must have checked
 * `request.bodyUsed` (a used body cannot be cloned).
 */
export async function readCappedBody(
  request: Request,
  maxBytes: number,
): Promise<Uint8Array | null | typeof TOO_LARGE> {
  const declared = Number(request.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) return TOO_LARGE;
  const stream = request.clone().body;
  if (stream === null) return null;
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > maxBytes) {
      // Not awaited: cancelling one branch of a clone settles only once the other is read too.
      void reader.cancel().catch(() => undefined);
      return TOO_LARGE;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}
