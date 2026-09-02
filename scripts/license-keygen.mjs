/**
 * One-time: generate your Ed25519 licensing keypair.
 *   node scripts/license-keygen.mjs
 * Writes license-private.pem (KEEP SECRET, never commit/ship) and prints the
 * public key in the base64url form to paste into src/shared/license/publicKey.ts.
 */
import { generateKeyPairSync } from 'node:crypto';
import { writeFileSync, existsSync } from 'node:fs';

if (existsSync('license-private.pem')) {
  console.error('license-private.pem already exists — refusing to overwrite. Delete it first if you really mean to.');
  process.exit(1);
}

const { publicKey, privateKey } = generateKeyPairSync('ed25519');

writeFileSync('license-private.pem', privateKey.export({ type: 'pkcs8', format: 'pem' }));

const spkiDer = publicKey.export({ type: 'spki', format: 'der' });
const b64url = spkiDer.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

console.log('Wrote license-private.pem (keep this secret!)\n');
console.log('Paste this into src/shared/license/publicKey.ts as LICENSE_PUBLIC_KEY_B64URL:\n');
console.log(b64url);
