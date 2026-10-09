import { describe, expect, it, vi } from 'vitest';
import { TEST_VECTOR_KIDS } from './contract.js';
import { JwksCache } from './jwks-cache.js';

const KEY_A = {
  kty: 'OKP',
  crv: 'Ed25519',
  x: 'm7lQTamkbt82g45zLo7sH9MPph4QoWYr0M425R5fjMU',
  kid: 'a',
  alg: 'EdDSA',
  use: 'sig',
};
const KEY_B = { ...KEY_A, kid: 'b', x: 'sJBTox1kj2GaPjCdsxANuVsWSBCWEp3z8eDgdSVhQcQ' };

function setup(initialKeys: unknown[], extra: { allowTestVectorKeys?: boolean } = {}) {
  let keys = initialKeys;
  let nowMs = 1_790_000_000_000;
  const fetchMock = vi.fn((_url: string | URL | Request, _init?: RequestInit) =>
    Promise.resolve(new Response(JSON.stringify({ keys }), { status: 200 })),
  );
  const cache = new JwksCache({
    apiOrigin: 'https://api.craftedai.test/',
    fetch: fetchMock,
    now: () => nowMs,
    ...extra,
  });
  return {
    cache,
    fetchMock,
    publish: (next: unknown[]) => (keys = next),
    advance: (seconds: number) => (nowMs += seconds * 1000),
  };
}

describe('JwksCache (spec §5.2 rule 1)', () => {
  it('fetches {apiOrigin}/.well-known/jwks.json once and serves from cache', async () => {
    const { cache, fetchMock } = setup([KEY_A]);
    expect((await cache.lookup('a')).status).toBe('found');
    expect((await cache.lookup('a')).status).toBe('found');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      'https://api.craftedai.test/.well-known/jwks.json',
    );
    expect(cache.url).toBe('https://api.craftedai.test/.well-known/jwks.json');
  });

  it('refetches on an unknown kid, at most once every 30 s', async () => {
    const { cache, fetchMock, publish, advance } = setup([KEY_A]);
    await cache.lookup('a');
    advance(31);
    publish([KEY_A, KEY_B]);
    expect((await cache.lookup('b')).status).toBe('found');
    expect(fetchMock).toHaveBeenCalledTimes(2);

    expect((await cache.lookup('forged-1')).status).toBe('unknown');
    expect((await cache.lookup('forged-2')).status).toBe('unknown');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    advance(30);
    await cache.lookup('forged-3');
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('refreshes after max-age (300 s)', async () => {
    const { cache, fetchMock, advance } = setup([KEY_A]);
    await cache.lookup('a');
    advance(299);
    await cache.lookup('a');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    advance(1);
    await cache.lookup('a');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('shares one fetch between concurrent misses', async () => {
    const { cache, fetchMock } = setup([KEY_A]);
    const results = await Promise.all([cache.lookup('a'), cache.lookup('a'), cache.lookup('a')]);
    expect(results.map((r) => r.status)).toEqual(['found', 'found', 'found']);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('shares one fetch between concurrent lookups of different kids at a cold start', async () => {
    const { cache, fetchMock } = setup([KEY_A, KEY_B]);
    const results = await Promise.all([cache.lookup('a'), cache.lookup('b'), cache.lookup('zzz')]);
    expect(results.map((r) => r.status)).toEqual(['found', 'found', 'unknown']);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('drops malformed keys and keys carrying d', async () => {
    const { cache } = setup([
      { ...KEY_A, d: KEY_A.x },
      { ...KEY_B, kty: 'RSA' },
    ]);
    expect((await cache.lookup('a')).status).toBe('unknown');
    expect((await cache.lookup('b')).status).toBe('unknown');
  });

  it('drops a kid that appears twice: which key signs is ambiguous', async () => {
    const { cache } = setup([KEY_A, { ...KEY_B, kid: 'a' }, KEY_B]);
    expect((await cache.lookup('a')).status).toBe('unknown');
    expect((await cache.lookup('b')).status).toBe('found');
  });

  it('keeps serving the last good keys while the JWKS is down, retrying at most every 30 s', async () => {
    const { cache, fetchMock, advance } = setup([KEY_A]);
    await cache.lookup('a');
    fetchMock.mockImplementation(() => Promise.reject(new Error('ECONNRESET')));
    advance(300);
    expect((await cache.lookup('a')).status).toBe('found');
    expect((await cache.lookup('a')).status).toBe('found');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('reports unavailable, with a message, when the JWKS was never fetched', async () => {
    const cache = new JwksCache({
      apiOrigin: 'https://api.craftedai.test',
      fetch: () => Promise.reject(new Error('ECONNREFUSED')),
      now: () => 0,
    });
    const result = await cache.lookup('a');
    expect(result.status).toBe('unavailable');
    expect(result).toMatchObject({ message: expect.stringContaining('unreachable') });
  });

  it('describes an unknown kid without echoing it', async () => {
    const { cache } = setup([KEY_A]);
    const result = await cache.lookup('attacker-controlled');
    expect(result.status).toBe('unknown');
    expect(JSON.stringify(result)).not.toContain('attacker-controlled');
    expect(result).toMatchObject({ message: expect.any(String) });
  });
});

describe('JwksCache fails closed', () => {
  it.each([
    ['HTTP 503', () => new Response('nope', { status: 503 }), 'HTTP 503'],
    ['non-JSON body', () => new Response('<html>', { status: 200 }), 'malformed'],
    ['no keys member', () => new Response('{}', { status: 200 }), 'malformed'],
    ['keys not an array', () => new Response('{"keys":{}}', { status: 200 }), 'malformed'],
    ['a JSON array', () => new Response('[]', { status: 200 }), 'malformed'],
  ])('%s: never fetched -> unavailable, no key accepted', async (_label, respond, text) => {
    const cache = new JwksCache({
      apiOrigin: 'https://api.craftedai.test',
      fetch: () => Promise.resolve(respond()),
      now: () => 0,
    });
    const result = await cache.lookup('a');
    expect(result.status).toBe('unavailable');
    expect(result).toMatchObject({ message: expect.stringContaining(text) });
  });

  it('a malformed refresh keeps the last good keys and does not replace them with nothing', async () => {
    const { cache, fetchMock, advance } = setup([KEY_A]);
    await cache.lookup('a');
    fetchMock.mockImplementation(() => Promise.resolve(new Response('{"keys":"x"}')));
    advance(300);
    expect((await cache.lookup('a')).status).toBe('found');
  });

  it('throttles to one attempt per 30 s after a failure, then retries and recovers', async () => {
    const { cache, fetchMock, advance } = setup([KEY_A]);
    fetchMock.mockImplementation(() => Promise.reject(new Error('ECONNREFUSED')));
    for (const kid of ['a', 'b', 'c']) {
      expect((await cache.lookup(kid)).status).toBe('unavailable');
    }
    expect(fetchMock).toHaveBeenCalledTimes(1);
    advance(29);
    await cache.lookup('a');
    expect(fetchMock).toHaveBeenCalledTimes(1);

    advance(1);
    fetchMock.mockImplementation(() =>
      Promise.resolve(new Response(JSON.stringify({ keys: [KEY_A] }))),
    );
    expect((await cache.lookup('a')).status).toBe('found');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['HTTP 503', () => Promise.resolve(new Response('nope', { status: 503 }))],
    ['malformed body', () => Promise.resolve(new Response('{"keys":1}'))],
  ])('throttles to one attempt per 30 s after %s too', async (_label, respond) => {
    const { cache, fetchMock, advance } = setup([KEY_A]);
    fetchMock.mockImplementation(respond);
    for (const kid of ['a', 'b', 'c']) await cache.lookup(kid);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    advance(30);
    await cache.lookup('a');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('times out a hung fetch and clears the in-flight slot', async () => {
    const hang = vi.fn((_url: string | URL | Request, init?: RequestInit) =>
      init?.signal === undefined || init.signal === null
        ? new Promise<Response>(() => undefined)
        : new Promise<Response>((_resolve, reject) => {
            init.signal?.addEventListener('abort', () => reject(new Error('aborted')));
          }),
    );
    let nowMs = 0;
    const cache = new JwksCache({
      apiOrigin: 'https://api.craftedai.test',
      fetch: hang,
      now: () => nowMs,
      timeoutMs: 20,
    });
    expect((await cache.lookup('a')).status).toBe('unavailable');
    nowMs += 30_000;
    expect((await cache.lookup('a')).status).toBe('unavailable');
    expect(hang).toHaveBeenCalledTimes(2);
  });

  it('never fetches for a malformed kid (precondition guard)', async () => {
    const { cache, fetchMock } = setup([KEY_A]);
    for (const kid of ['', 'k'.repeat(129)]) {
      expect((await cache.lookup(kid)).status).toBe('unknown');
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('does not follow redirects', async () => {
    const { cache, fetchMock } = setup([KEY_A]);
    await cache.lookup('a');
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ redirect: 'error' });
  });
});

describe('JwksCache refuses the published test-vector keys', () => {
  const vectorKey = { ...KEY_A, kid: TEST_VECTOR_KIDS[0] };

  it('has the three core-api test-vector kids', () => {
    expect(TEST_VECTOR_KIDS).toHaveLength(3);
  });

  it.each(TEST_VECTOR_KIDS)('never serves kid %s by default', async (kid) => {
    const { cache } = setup([KEY_A, { ...KEY_A, kid }]);
    expect((await cache.lookup(kid)).status).toBe('unknown');
    expect((await cache.lookup('a')).status).toBe('found');
  });

  it('serves them only when allowTestVectorKeys is set explicitly', async () => {
    const { cache } = setup([vectorKey], { allowTestVectorKeys: true });
    expect((await cache.lookup(TEST_VECTOR_KIDS[0]!)).status).toBe('found');
  });

  it('allowTestVectorKeys: false is the same as the default', async () => {
    const { cache } = setup([vectorKey], { allowTestVectorKeys: false });
    expect((await cache.lookup(TEST_VECTOR_KIDS[0]!)).status).toBe('unknown');
  });
});
