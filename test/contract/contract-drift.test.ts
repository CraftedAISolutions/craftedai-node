import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  isDelegationTokenHeader,
  parseDelegationTokenClaims,
  parsePublicSigningJwk,
  parseRequestTokenClaims,
  parseRequestTokenHeader,
} from '../../src/claims.js';
import * as lib from '../../src/contract.js';
import * as coreDelegation from './core-api/delegation-token-wire.js';
import * as coreEmbed from './core-api/embed-wire-constants.js';
import * as coreRequest from './core-api/request-token-wire.js';

/**
 * Drift guard for the frozen contract. `./core-api/*.ts` are byte-for-byte
 * copies of core-api `src/domain/request-signing/*-wire.ts` and
 * `src/domain/embed/embed-wire-constants.ts` (CRA-350, merged at d51e02a); the
 * `contract-sync` CI job fails when they differ from core-api `main`.
 */

const SHARED_CONSTANTS = [
  'REQUEST_TOKEN_HEADER',
  'REQUEST_TOKEN_TYP',
  'REQUEST_TOKEN_ALG',
  'REQUEST_TOKEN_LIFETIME_SECONDS',
  'REQUEST_TOKEN_MAX_CLOCK_SKEW_SECONDS',
  'JWKS_PATH',
  'JWKS_CACHE_MAX_AGE_SECONDS',
  'JWKS_UNKNOWN_KID_REFETCH_MIN_INTERVAL_SECONDS',
  'VERIFICATION_FAILED_ERROR',
  'REQUEST_VERIFICATION_REASONS',
  'BODY_HASH_RE',
  'EMPTY_BODY_HASH',
  'KNOWN_CHANNELS',
] as const;

const SHARED_EMBED_CONSTANTS = [
  'ACTOR_DELEGATION_HEADER',
  'EMBED_SESSION_TOKEN_RE',
  'EMBED_SESSION_TTL_SECONDS',
] as const;

const SHARED_DELEGATION_CONSTANTS = [
  'DELEGATION_TOKEN_ALG',
  'DELEGATION_TOKEN_TYP',
  'DELEGATION_TOKEN_ISSUER',
  'DELEGATION_TOKEN_AUDIENCE',
  'DELEGATION_TOKEN_LIFETIME_SECONDS',
  'DELEGATION_DEFAULT_CALL_LIMIT',
  'APP_SECRET_MIN_BYTES',
  'APP_SECRET_RE',
  'DELEGATION_MAX_CLOCK_SKEW_SECONDS',
] as const;

const VALID_CLAIMS = {
  iss: 'https://api.craftedai.co',
  aud: 'https://mcp.customer.test/mcp',
  sub: 'org-1',
  iid: 'int-1',
  iat: 1_790_000_000,
  exp: 1_790_000_060,
  jti: 'j-1',
  bh: '47DEQpj8HBSa-_TImW-5JCeuQeRkm5NMpJWZG3hSuFU',
};
const ACT = { externalUserId: 'member-1', channel: 'api', conversationId: 'c-1' };

const CLAIM_CASES: [string, unknown][] = [
  ['valid', VALID_CLAIMS],
  ['valid with act', { ...VALID_CLAIMS, act: ACT }],
  ['unknown claim ignored', { ...VALID_CLAIMS, extra: 1 }],
  ['exp == iat', { ...VALID_CLAIMS, exp: VALID_CLAIMS.iat }],
  ['iss not a url', { ...VALID_CLAIMS, iss: 'api.craftedai.co' }],
  ['aud not a url', { ...VALID_CLAIMS, aud: '/mcp' }],
  ['aud with query', { ...VALID_CLAIMS, aud: 'https://x.test/mcp?tenant=1' }],
  ['empty sub', { ...VALID_CLAIMS, sub: '' }],
  ['sub 129 chars', { ...VALID_CLAIMS, sub: 'a'.repeat(129) }],
  ['iat float', { ...VALID_CLAIMS, iat: 1.5 }],
  ['iat negative', { ...VALID_CLAIMS, iat: -1 }],
  ['exp zero', { ...VALID_CLAIMS, iat: 0, exp: 0 }],
  ['exp string', { ...VALID_CLAIMS, exp: '1790000060' }],
  ['bh 42 chars', { ...VALID_CLAIMS, bh: 'a'.repeat(42) }],
  ['bh padded', { ...VALID_CLAIMS, bh: `${'a'.repeat(42)}=` }],
  ['act open channel', { ...VALID_CLAIMS, act: { ...ACT, channel: 'whatsapp' } }],
  ['act channel web', { ...VALID_CLAIMS, act: { ...ACT, channel: 'web' } }],
  ['act channel 32 chars', { ...VALID_CLAIMS, act: { ...ACT, channel: 'a'.repeat(32) } }],
  ['act channel 33 chars', { ...VALID_CLAIMS, act: { ...ACT, channel: 'a'.repeat(33) } }],
  ['act empty channel', { ...VALID_CLAIMS, act: { ...ACT, channel: '' } }],
  ['act numeric channel', { ...VALID_CLAIMS, act: { ...ACT, channel: 1 } }],
  [
    'act conversationId 129 chars',
    { ...VALID_CLAIMS, act: { ...ACT, conversationId: 'a'.repeat(129) } },
  ],
  ['opaque jti', { ...VALID_CLAIMS, jti: 'not-a-uuid_123' }],
  ['act empty user', { ...VALID_CLAIMS, act: { ...ACT, externalUserId: '' } }],
  ['act null', { ...VALID_CLAIMS, act: null }],
  ['missing jti', { ...VALID_CLAIMS, jti: undefined }],
  ['array', [VALID_CLAIMS]],
  ['null', null],
];

const DELEGATION = {
  iss: 'craftedai-node',
  aud: 'craftedai-delegation',
  sub: 'member-1',
  org: 'org-1',
  iat: 1_790_000_000,
  exp: 1_790_000_300,
  jti: 'd-1',
};
const DELEGATION_CASES: [string, unknown][] = [
  ['valid', DELEGATION],
  ['aud array', { ...DELEGATION, aud: ['craftedai-delegation'] }],
  ['wrong iss', { ...DELEGATION, iss: 'someone-else' }],
  ['sub with space', { ...DELEGATION, sub: 'member 1' }],
  ['sub 257 chars', { ...DELEGATION, sub: 'a'.repeat(257) }],
  ['empty org', { ...DELEGATION, org: '' }],
  ['exp before iat', { ...DELEGATION, exp: DELEGATION.iat - 1 }],
];

const JWK = {
  kty: 'OKP',
  crv: 'Ed25519',
  x: 'm7lQTamkbt82g45zLo7sH9MPph4QoWYr0M425R5fjMU',
  kid: 'k1',
  alg: 'EdDSA',
  use: 'sig',
};
const JWK_CASES: [string, unknown][] = [
  ['valid', JWK],
  ['carries d', { ...JWK, d: JWK.x }],
  ['RSA', { ...JWK, kty: 'RSA' }],
  ['no use', { ...JWK, use: undefined }],
];

describe('frozen contract drift (CRA-350 → @craftedai/node)', () => {
  it.each(SHARED_CONSTANTS)('%s equals core-api', (name) => {
    expect(lib[name]).toEqual(coreRequest[name]);
  });

  it.each(SHARED_DELEGATION_CONSTANTS)('%s equals core-api', (name) => {
    expect(lib[name]).toEqual(coreDelegation[name]);
  });

  it.each(SHARED_EMBED_CONSTANTS)('%s equals core-api embed-wire-constants', (name) => {
    expect(lib[name]).toEqual(coreEmbed[name]);
  });

  it('the vectors file is the 36-case core-api file this contract was pinned against', () => {
    const vectors = JSON.parse(
      readFileSync(new URL('../vectors/request-token.json', import.meta.url), 'utf8'),
    ) as { cases: unknown[] };
    expect(vectors.cases).toHaveLength(36);
    expect(lib.KNOWN_CHANNELS).toEqual(['web', 'api']);
  });

  it.each(CLAIM_CASES)('request claims "%s": hand mirror agrees with zod', (_label, input) => {
    expect(parseRequestTokenClaims(input) !== null).toBe(
      coreRequest.RequestTokenClaimsSchema.safeParse(input).success,
    );
  });

  it.each([
    ['valid', { alg: 'EdDSA', typ: 'craftedai-req+jwt', kid: 'k1' }],
    ['alg none', { alg: 'none', typ: 'craftedai-req+jwt', kid: 'k1' }],
    ['typ JWT', { alg: 'EdDSA', typ: 'JWT', kid: 'k1' }],
    ['empty kid', { alg: 'EdDSA', typ: 'craftedai-req+jwt', kid: '' }],
    ['missing kid', { alg: 'EdDSA', typ: 'craftedai-req+jwt' }],
    ['kid 128 chars', { alg: 'EdDSA', typ: 'craftedai-req+jwt', kid: 'a'.repeat(128) }],
    ['kid 129 chars', { alg: 'EdDSA', typ: 'craftedai-req+jwt', kid: 'a'.repeat(129) }],
    ['kid number', { alg: 'EdDSA', typ: 'craftedai-req+jwt', kid: 1 }],
    ['unknown member ignored', { alg: 'EdDSA', typ: 'craftedai-req+jwt', kid: 'k1', x: 1 }],
  ])('request header "%s": hand mirror agrees with zod', (_label, input) => {
    expect(parseRequestTokenHeader(input) !== null).toBe(
      coreRequest.RequestTokenHeaderSchema.safeParse(input).success,
    );
  });

  it.each(DELEGATION_CASES)('delegation claims "%s": hand mirror agrees with zod', (_l, input) => {
    expect(parseDelegationTokenClaims(input) !== null).toBe(
      coreDelegation.DelegationTokenClaimsSchema.safeParse(input).success,
    );
  });

  it.each([
    ['HS256 + JWT', { alg: 'HS256', typ: 'JWT' }],
    ['HS256, no typ', { alg: 'HS256' }],
    ['HS512', { alg: 'HS512', typ: 'JWT' }],
    ['typ jwt lowercase', { alg: 'HS256', typ: 'jwt' }],
    ['typ other', { alg: 'HS256', typ: 'at+jwt' }],
    ['typ null', { alg: 'HS256', typ: null }],
    ['HS256 + extra', { alg: 'HS256', typ: 'JWT', kid: 'x' }],
  ])('delegation header "%s": hand mirror agrees with zod', (_label, input) => {
    expect(isDelegationTokenHeader(input)).toBe(
      coreDelegation.DelegationTokenHeaderSchema.safeParse(input).success,
    );
  });

  it.each(JWK_CASES)('JWKS key "%s": hand mirror agrees with zod', (_label, input) => {
    expect(parsePublicSigningJwk(input) !== null).toBe(
      coreRequest.RequestSigningPublicJwkSchema.safeParse(input).success,
    );
  });
});
