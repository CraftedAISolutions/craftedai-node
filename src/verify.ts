import {
  compactVerify,
  decodeProtectedHeader,
  importJWK,
  type CryptoKey,
  type KeyObject,
} from 'jose';
import { bodyHash } from './body-hash.js';
import {
  parseRequestTokenClaims,
  parseRequestTokenHeader,
  type PublicSigningJwk,
  type RequestTokenAct,
} from './claims.js';
import {
  ACTOR_DELEGATION_HEADER,
  REQUEST_TOKEN_ALG,
  REQUEST_TOKEN_HEADER,
  REQUEST_TOKEN_MAX_CLOCK_SKEW_SECONDS,
  VERIFICATION_FAILED_ERROR,
  type RequestVerificationReason,
} from './contract.js';
import { verifyDelegationToken } from './delegation.js';
import type { JwksCache } from './jwks-cache.js';
import type { RecordRequestInput, ReplayStore } from './replay/replay-store.js';

/** What a verified request carries into the MCP handler (`req.craftedai`). */
export interface CraftedAIRequestContext {
  /** The CraftedAI organization (`sub`), always equal to `CRAFTEDAI_ORG_ID`. */
  orgId: string;
  /** The integration id (`iid`). */
  integrationId: string;
  /** The end user (`act.externalUserId`), or null on `tools/list`, `initialize`, … */
  user: string | null;
  /** True when a valid delegation token for `user` came with the request (spec §5.3). */
  delegated: boolean;
  /** The full `act` claim, or null. */
  act: RequestTokenAct | null;
}

export type VerifyResult =
  | { ok: true; context: CraftedAIRequestContext }
  | { ok: false; reason: RequestVerificationReason; message?: string };

/** The 401 body every adapter sends (core-api `VerificationFailureBodySchema`). */
export interface VerificationFailureBody {
  error: typeof VERIFICATION_FAILED_ERROR;
  reason: RequestVerificationReason;
  message?: string;
}

const MAX_MESSAGE_LENGTH = 500;

export function failureBody(result: Extract<VerifyResult, { ok: false }>): VerificationFailureBody {
  return {
    error: VERIFICATION_FAILED_ERROR,
    reason: result.reason,
    ...(result.message !== undefined
      ? { message: result.message.slice(0, MAX_MESSAGE_LENGTH) }
      : {}),
  };
}

/** A request reduced to what the verifier reads. Adapters build one. */
export interface RawRequest {
  method: string;
  /** Absolute URL this server was reached at, derived from the request. */
  url: string;
  header(name: string): string | undefined;
  /** Exact bytes received; null when there is no body. */
  body: Uint8Array | null;
}

export interface VerifierDeps {
  /** Configured API origin, no trailing slash: the only accepted `iss`. */
  apiOrigin: string;
  orgId: string;
  /** Needed only when a request carries `act` and `requireDelegation` is on. */
  appSecret: string | undefined;
  /** `CRAFTEDAI_APP_SECRET_PREVIOUS`: also accepted for delegations during a rotation. Verify only. */
  previousAppSecret?: string | undefined;
  requireDelegation: boolean;
  delegationCallLimit: number;
  /** The URL(s) core-api has stored for this MCP; default: derived from the request. */
  publicUrl: readonly string[] | undefined;
  jwks: JwksCache;
  replay: ReplayStore;
  /** Unix milliseconds. */
  now: () => number;
}

/** Hint that names the cause of the failure customers hit most often (spec §12.3). */
export const BODY_MISMATCH_HINT =
  'the request body differs from the signed body; mount verifyRequest() before any body parser (for example express.json())';

const fail = (reason: RequestVerificationReason, message?: string): VerifyResult =>
  message === undefined ? { ok: false, reason } : { ok: false, reason, message };

type VerifyingKey = CryptoKey | KeyObject | Uint8Array;

/** Imported keys by `kid:x`: the JWKS holds a handful of keys, so this stays tiny. */
const importedKeys = new Map<string, Promise<VerifyingKey>>();
function keyFor(jwk: PublicSigningJwk): Promise<VerifyingKey> {
  const cacheKey = `${jwk.kid}:${jwk.x}`;
  let key = importedKeys.get(cacheKey);
  if (key === undefined) {
    key = importJWK({ kty: jwk.kty, crv: jwk.crv, x: jwk.x }, REQUEST_TOKEN_ALG);
    importedKeys.set(cacheKey, key);
  }
  return key;
}

/**
 * Spec §5.2, rules 1–8, in the frozen check order; the first failing check
 * names the reason. The request `jti` (and a delegation use) is recorded only
 * after every check passed, in ONE atomic `recordRequest` call, so a rejected
 * request never burns either and two instances racing on one jti or one
 * delegation cannot both pass. Behaviour on every shared vector equals
 * core-api's reference verifier.
 */
export async function verifyRawRequest(
  request: RawRequest,
  deps: VerifierDeps,
): Promise<VerifyResult> {
  const nowSeconds = Math.floor(deps.now() / 1000);

  const token = request.header(REQUEST_TOKEN_HEADER);
  if (token === undefined || token.length === 0) return fail('missing_token');

  // The whole protected header (alg, typ, kid) is validated before any key lookup: a wrong
  // alg or typ and a missing, empty or oversized kid are bad_signature, never a JWKS fetch.
  let protectedHeader: ReturnType<typeof decodeProtectedHeader>;
  try {
    protectedHeader = decodeProtectedHeader(token);
  } catch {
    return fail('bad_signature');
  }
  const header = parseRequestTokenHeader(protectedHeader);
  if (header === null) return fail('bad_signature');

  // Rule 1: a well-formed kid in the JWKS. Unknown and unavailable are both unknown_key.
  const lookup = await deps.jwks.lookup(header.kid);
  if (lookup.status === 'unavailable') {
    return fail('unknown_key', `could not fetch the CraftedAI signing keys from ${deps.jwks.url}`);
  }
  if (lookup.status === 'unknown') return fail('unknown_key');

  let payload: Uint8Array;
  try {
    ({ payload } = await compactVerify(token, await keyFor(lookup.jwk), {
      algorithms: [REQUEST_TOKEN_ALG],
    }));
  } catch {
    return fail('bad_signature');
  }
  let rawClaims: unknown;
  try {
    rawClaims = JSON.parse(new TextDecoder().decode(payload));
  } catch {
    return fail('bad_signature');
  }
  const claims = parseRequestTokenClaims(rawClaims);
  if (claims === null) return fail('bad_signature');

  // Issuer, org pin, audience (an exact string compare: no URL normalisation).
  if (claims.iss !== deps.apiOrigin) {
    return fail(
      'wrong_issuer',
      `token issuer is ${claims.iss}; this server expects ${deps.apiOrigin}`,
    );
  }
  if (claims.sub !== deps.orgId) {
    return fail(
      'wrong_org',
      'token was issued for another CraftedAI organization (CRAFTEDAI_ORG_ID)',
    );
  }
  const accepted = deps.publicUrl ?? [request.url];
  if (!accepted.includes(claims.aud)) {
    return fail(
      'wrong_audience',
      `token audience is ${claims.aud} but this server is reached at ${accepted.join(', ')}; set publicUrl (or CRAFTEDAI_PUBLIC_URL) to the URL registered in CraftedAI`,
    );
  }

  // Expiry: exp strictly in the future, iat at most 60 s ahead.
  if (claims.iat > nowSeconds + REQUEST_TOKEN_MAX_CLOCK_SKEW_SECONDS) {
    return fail(
      'expired',
      `token issued ${claims.iat - nowSeconds} s in this server's future (60 s tolerated); this server's clock is behind, sync it with NTP`,
    );
  }
  if (claims.exp <= nowSeconds) {
    return fail(
      'expired',
      `token expired ${nowSeconds - claims.exp} s ago; if this server's clock is ahead, sync it with NTP`,
    );
  }

  // Replay: a read-only pre-check so a replay is named before the body is hashed. The
  // authoritative, atomic check is `recordRequest` below.
  const jtiKey = `req:${claims.jti}`;
  if (await deps.replay.has(jtiKey)) return fail('replayed');

  // Body binding.
  if (claims.bh !== bodyHash(request.body)) return fail('body_mismatch', BODY_MISMATCH_HINT);

  // Delegation for an end-user call.
  let delegation: RecordRequestInput['delegation'];
  if (claims.act !== undefined && deps.requireDelegation) {
    const delegationToken = request.header(ACTOR_DELEGATION_HEADER);
    if (delegationToken === undefined || delegationToken.length === 0) {
      return fail('delegation_missing');
    }
    if (deps.appSecret === undefined) {
      return fail('delegation_invalid', 'CRAFTEDAI_APP_SECRET is not configured on this server');
    }
    const delegationClaims = await verifyDelegationToken(delegationToken, {
      appSecret: deps.appSecret,
      previousAppSecret: deps.previousAppSecret,
      orgId: deps.orgId,
      nowSeconds,
    });
    if (delegationClaims === null) return fail('delegation_invalid');
    if (delegationClaims.sub !== claims.act.externalUserId) return fail('delegation_user_mismatch');
    delegation = {
      key: `del:${delegationClaims.jti}`,
      limit: deps.delegationCallLimit,
      expiresAtSeconds: delegationClaims.exp,
    };
  }

  // Commit, last: record the jti and count the delegation use in one atomic store call.
  const outcome = await deps.replay.recordRequest({
    jtiKey,
    jtiExpiresAtSeconds: claims.exp,
    ...(delegation !== undefined ? { delegation } : {}),
  });
  if (outcome === 'replayed') return fail('replayed');
  if (outcome === 'delegation_exhausted') return fail('delegation_exhausted');

  return {
    ok: true,
    context: {
      orgId: claims.sub,
      integrationId: claims.iid,
      user: claims.act?.externalUserId ?? null,
      delegated: delegation !== undefined,
      act: claims.act ?? null,
    },
  };
}
