/**
 * The vendor's Ed25519 PUBLIC key (SPKI, base64url of the DER bytes). Safe to
 * ship — it can only VERIFY codes, not create them.
 *
 * Replace the placeholder below with the output of `node scripts/license-keygen.mjs`
 * before you ship. Until then, no license code will verify (the app still runs
 * the free trial normally, and activation simply reports "invalid code").
 */
export const LICENSE_PUBLIC_KEY_B64URL: string =
  'MCowBQYDK2VwAyEAYsO5MqJOGn1b8zOCNLkYFYFgIawoHrxbmBLJl9r9i7A';

export function hasLicenseKey(): boolean {
  return LICENSE_PUBLIC_KEY_B64URL !== 'REPLACE_ME_WITH_KEYGEN_OUTPUT';
}
