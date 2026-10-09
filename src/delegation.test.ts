import { readFileSync } from 'node:fs';
import { SignJWT } from 'jose';
import { describe, expect, it } from 'vitest';
import { mintDelegationToken, verifyDelegationToken } from './delegation.js';

// Test-only secret, generated for this file. Deliberately NOT the shared
// vectors' app secret (that one is public and must never be a usable default).
const SECRET = 'HdAmaKyBek35omQhDFgMuoWuWgCuY7iv0PTSIXRcqas';
const ORG = 'org-1';
const NOW = 1_790_000_000;

async function mint(overrides: Partial<Parameters<typeof mintDelegationToken>[0]> = {}) {
  return mintDelegationToken({
    appSecret: SECRET,
    orgId: ORG,
    externalUserId: 'member-1',
    nowSeconds: NOW,
    jti: 'd-1',
    ...overrides,
  });
}

const verify = (token: string, nowSeconds = NOW, appSecret = SECRET) =>
  verifyDelegationToken(token, { appSecret, orgId: ORG, nowSeconds });

/** A token with the frozen claim set, signed with `SECRET`, and a caller-chosen protected header. */
function signWithHeader(header: { alg: string; typ?: string }, secret = SECRET) {
  return new SignJWT({ org: ORG })
    .setProtectedHeader(header)
    .setIssuer('craftedai-node')
    .setAudience('craftedai-delegation')
    .setSubject('member-1')
    .setIssuedAt(NOW)
    .setExpirationTime(NOW + 300)
    .setJti('d-1')
    .sign(new TextEncoder().encode(secret));
}

describe('delegation token (spec §5.3)', () => {
  it('mints the frozen claim set, 300 s, and expiresAt = exp', async () => {
    const { token, expiresAt } = await mint();
    expect(await verify(token)).toEqual({
      iss: 'craftedai-node',
      aud: 'craftedai-delegation',
      sub: 'member-1',
      org: ORG,
      iat: NOW,
      exp: NOW + 300,
      jti: 'd-1',
    });
    expect(expiresAt).toBe(new Date((NOW + 300) * 1000).toISOString());
  });

  it('keys HS256 with the UTF-8 bytes of the secret string, not its decoded bytes', async () => {
    const { token } = await mint();
    const decodedKey = Buffer.from(SECRET, 'base64url');
    const forged = await new SignJWT({ org: ORG })
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setIssuer('craftedai-node')
      .setAudience('craftedai-delegation')
      .setSubject('member-1')
      .setIssuedAt(NOW)
      .setExpirationTime(NOW + 300)
      .setJti('d-1')
      .sign(decodedKey);
    expect(await verify(token)).not.toBeNull();
    expect(await verify(forged)).toBeNull();
  });

  it.each([
    ['another secret (forged)', async () => verify((await mint()).token, NOW, `${SECRET}x`)],
    ['exp reached', async () => verify((await mint()).token, NOW + 300)],
    ['iat 61 s ahead', async () => verify((await mint()).token, NOW - 61)],
    ['another org', async () => verify((await mint({ orgId: 'org-2' })).token)],
    ['not a JWT', async () => verify('not-a-jwt')],
  ])('refuses %s', async (_label, run) => {
    expect(await run()).toBeNull();
  });

  it('accepts iat 60 s ahead (skew allowance)', async () => {
    expect(await verify((await mint()).token, NOW - 60)).not.toBeNull();
  });

  it('refuses HS512 even with the right secret (alg pinned)', async () => {
    const token = await signWithHeader({ alg: 'HS512', typ: 'JWT' });
    expect(await verify(token)).toBeNull();
  });

  it('accepts an absent typ (merged contract: typ is JWT or absent)', async () => {
    expect(await verify(await signWithHeader({ alg: 'HS256' }))).toMatchObject({ sub: 'member-1' });
  });

  it.each(['JWS', 'jwt', 'craftedai-req+jwt'])(
    'refuses typ %s with the right secret',
    async (typ) => {
      expect(await verify(await signWithHeader({ alg: 'HS256', typ }))).toBeNull();
    },
  );
});

describe('app secret rotation overlap (CRAFTEDAI_APP_SECRET_PREVIOUS)', () => {
  const PREVIOUS = 'Q0hBTkdFLU1FLW9sZC1hcHAtc2VjcmV0LTQzLWNoYXJzLXg';
  const verifyBoth = (token: string, previousAppSecret?: string) =>
    verifyDelegationToken(token, {
      appSecret: SECRET,
      previousAppSecret,
      orgId: ORG,
      nowSeconds: NOW,
    });

  it('accepts a token signed with the previous secret while it is configured', async () => {
    const { token } = await mint({ appSecret: PREVIOUS });
    expect(await verifyBoth(token, PREVIOUS)).toMatchObject({ sub: 'member-1', jti: 'd-1' });
  });

  it('refuses that token once the previous secret is removed', async () => {
    const { token } = await mint({ appSecret: PREVIOUS });
    expect(await verifyBoth(token)).toBeNull();
  });

  it('still accepts the current secret during the overlap', async () => {
    const { token } = await mint();
    expect(await verifyBoth(token, PREVIOUS)).not.toBeNull();
  });

  it('refuses a token signed with neither secret', async () => {
    const { token } = await mint({ appSecret: `${PREVIOUS}x` });
    expect(await verifyBoth(token, PREVIOUS)).toBeNull();
  });

  it('applies every other rule to a previous-secret token (another org is still refused)', async () => {
    const { token } = await mint({ appSecret: PREVIOUS, orgId: 'org-2' });
    expect(await verifyBoth(token, PREVIOUS)).toBeNull();
  });

  it('applies the typ rule to a previous-secret token', async () => {
    const token = await signWithHeader({ alg: 'HS256', typ: 'JWS' }, PREVIOUS);
    expect(await verifyBoth(token, PREVIOUS)).toBeNull();
  });
});

interface VectorCase {
  name: string;
  now: number;
  request: { headers: Record<string, string> };
  expected: { ok: boolean; reason?: string };
}

const vectors = JSON.parse(
  readFileSync(new URL('../test/vectors/request-token.json', import.meta.url), 'utf8'),
) as { config: { appSecret: string; orgId: string }; cases: VectorCase[] };

/** Verdicts the reference verifier reaches only AFTER the delegation token itself verified. */
const TOKEN_VALID_REASONS = new Set(['delegation_user_mismatch', 'delegation_exhausted']);

describe('shared request-token vectors: delegation tokens', () => {
  const cases = vectors.cases.filter(
    (c) =>
      c.request.headers['x-craftedai-actor-delegation'] !== undefined &&
      (c.expected.ok ||
        c.expected.reason === 'delegation_invalid' ||
        TOKEN_VALID_REASONS.has(c.expected.reason ?? '')),
  );

  it('covers the delegation vectors', () => {
    expect(cases.map((c) => c.name)).toEqual(
      expect.arrayContaining([
        'valid_tools_call_with_delegation',
        'valid_delegation_typ_absent',
        'delegation_invalid_wrong_typ',
        'delegation_invalid_forged_secret',
        'delegation_invalid_expired',
        'delegation_invalid_wrong_org',
        'delegation_user_mismatch',
        'delegation_exhausted',
      ]),
    );
  });

  it.each(cases.map((c) => [c.name, c] as const))(
    'agrees with the reference verifier on %s',
    async (_name, c) => {
      const claims = await verifyDelegationToken(
        c.request.headers['x-craftedai-actor-delegation']!,
        {
          appSecret: vectors.config.appSecret,
          orgId: vectors.config.orgId,
          nowSeconds: c.now,
        },
      );
      expect(claims === null).toBe(c.expected.reason === 'delegation_invalid');
    },
  );
});
