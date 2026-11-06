import { createHash } from 'node:crypto';

/**
 * SHA-256 (hex) of every string in the shared test vectors (`test/vectors/request-token.json`)
 * that is shaped like an app secret (`APP_SECRET_RE`): the published `config.appSecret`, and
 * also the published private key members `d`, and the public `x` and `kid` values. All of it
 * is public by design, so a real deployment using any of it as an app secret would accept
 * forgeries from anyone who has read the vectors. The client refuses all of it at construction.
 *
 * Only hashes live here, so none of the plaintext is repeated in the shipped bundle.
 * `src/test-material.test.ts` walks the vectors file and fails when this list and the file
 * disagree, so a new or changed vector value cannot slip past unnoticed.
 */
export const TEST_VECTOR_APP_SECRET_SHA256S: readonly string[] = [
  '02fb40655699045e01987ca0092bf6c18f562e24850a530348e50f4fb040dc7d',
  '2a500ae76b8a47f066c14759dcdd8ae2520b71e06592c8320ee1a3efb935026d',
  '6f35cfafcd8fee78904194a31467a752fc07565376bd5831175d4f995b5b2033',
  'a3574844f57218d5c750f3ec2b9bf70cb5afda3866f7d56a03d39ffdc0e5da98',
  'f75600e9d7cbddc7d31219bf0b80f49a6ba4f66abafbd43a177fb9a5e914c242',
  'df9e87505a7072d4de36bce807a8038b683b60e605590754af87b59b43746d21',
  '6be2d2da598a32a34f5e9e97e29152210789c02c3b2cec8e7f4ee21557762d6f',
  '584f61f546f8d7c8f06e0c6a5c1589e42731ae73ff2ab33ec02dceaff337c7a9',
  '26db42449773d8088520d55167e26599bbfcf10bd038d503b50b349dc2685c20',
  '3b4c7247f42d5d279819268047cdd7c4260966c7394b32902ba518ed86200608',
];

export function isTestVectorAppSecret(value: string): boolean {
  const digest = createHash('sha256').update(value).digest('hex');
  return TEST_VECTOR_APP_SECRET_SHA256S.includes(digest);
}
