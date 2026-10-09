/**
 * Every error this library throws is a `CraftedAIError` with a stable `code`.
 * Messages never contain a secret, a token, a request body or a response body.
 */
export const CRAFTEDAI_ERROR_CODES = [
  /** A required setting (`CRAFTEDAI_SECRET_KEY`, `CRAFTEDAI_APP_SECRET`, `CRAFTEDAI_ORG_ID`) is missing. */
  'config_missing',
  /** A setting is present but malformed (e.g. an app secret shorter than 32 bytes). */
  'config_invalid',
  /** An argument failed validation (e.g. an external user id with a space). */
  'invalid_argument',
  /** core-api refused the `cai_` key (unknown, revoked, or retired after rotation). */
  'invalid_credentials',
  /** The key may not mint for this agent (core-api `agent_not_allowed_for_key`). */
  'agent_not_allowed_for_key',
  /** The agent is missing, unpublished or not embed-enabled (core-api `agent_unavailable`). */
  'agent_unavailable',
  /** The host origin is not on the agent's allowlist (core-api `embed_origin_not_allowed`). */
  'embed_origin_not_allowed',
  /** core-api answered 400 to the mint (shape or lifetime rules). */
  'invalid_request',
  /** core-api could not be reached, timed out, or answered something unexpected. */
  'api_unavailable',
] as const;
export type CraftedAIErrorCode = (typeof CRAFTEDAI_ERROR_CODES)[number];

export class CraftedAIError extends Error {
  public override readonly name = 'CraftedAIError';

  constructor(
    public readonly code: CraftedAIErrorCode,
    message: string,
    /** HTTP status core-api answered, when the error came from a response. */
    public readonly status?: number,
  ) {
    super(message);
  }
}
