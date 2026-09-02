/**
 * Mint a license code for a shop's machine.
 *   node scripts/license-sign.mjs <machineId> [expiryISO]
 *   node scripts/license-sign.mjs 9f3a1b7c...          # perpetual
 *   node scripts/license-sign.mjs 9f3a1b7c... 2027-01-01
 * Reads license-private.pem. Prints the code to send to the shop.
 */
import { sign as edSign, createPrivateKey } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';

const [, , machineIdArg, expArg] = process.argv;
if (!machineIdArg) {
  console.error('usage: node scripts/license-sign.mjs <machineId> [expiryISO]');
  process.exit(1);
}
if (!existsSync('license-private.pem')) {
  console.error('license-private.pem not found — run scripts/license-keygen.mjs first.');
  process.exit(1);
}

const machineId = machineIdArg.replace(/-/g, '').toLowerCase();
const exp = expArg ? new Date(expArg).toISOString() : null;
const iss = new Date().toISOString();
const payload = { machineId, exp, iss };

const b64url = (buf) =>
  buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

const payloadBytes = Buffer.from(JSON.stringify(payload), 'utf8');
const privateKey = createPrivateKey(readFileSync('license-private.pem'));
const signature = edSign(null, payloadBytes, privateKey);

const code = `${b64url(payloadBytes)}.${b64url(signature)}`;
console.log(`\nMachine: ${machineId}${exp ? `\nExpires: ${exp}` : '\n(perpetual)'}\n`);
console.log('License code (send to the shop):\n');
console.log(code);
