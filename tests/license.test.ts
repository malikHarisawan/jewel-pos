import { describe, it, expect, beforeEach } from 'vitest';
import { generateKeyPairSync, sign as edSign, type KeyObject } from 'node:crypto';
import { openDatabase, type DB } from '../src/main/db/connection.js';
import { LicenseService } from '../src/main/license/licenseService.js';

const DAY = 24 * 60 * 60 * 1000;
const MACHINE = 'a'.repeat(32);

let db: DB;
let privateKey: KeyObject;
let publicKeyB64: string;

function b64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Mint a code for a machine, signed with the test private key. */
function mintCode(machineId: string, exp: string | null = null): string {
  const payload = { machineId, exp, iss: new Date(0).toISOString() };
  const payloadBytes = Buffer.from(JSON.stringify(payload), 'utf8');
  const sig = edSign(null, payloadBytes, privateKey);
  return `${b64url(payloadBytes)}.${b64url(sig)}`;
}

function svc(nowMs: number) {
  return new LicenseService(db, () => nowMs, MACHINE, publicKeyB64);
}

beforeEach(() => {
  db = openDatabase({ filename: ':memory:' });
  const kp = generateKeyPairSync('ed25519');
  privateKey = kp.privateKey;
  publicKeyB64 = b64url(kp.publicKey.export({ type: 'spki', format: 'der' }) as Buffer);
});

const T0 = 1_000_000_000_000; // fixed "first boot" instant

describe('trial lifecycle', () => {
  it('starts in TRIAL with ~7 days left', () => {
    const info = svc(T0).getInfo();
    expect(info.status).toBe('TRIAL');
    expect(info.daysLeft).toBe(7);
    expect(info.machineId).toBe(MACHINE);
  });

  it('stays TRIAL within 7 days, then GRACE, then EXPIRED', () => {
    svc(T0).getInfo(); // set trial_start
    expect(svc(T0 + 3 * DAY).getInfo().status).toBe('TRIAL');
    expect(svc(T0 + 8 * DAY).getInfo().status).toBe('GRACE');
    expect(svc(T0 + 8 * DAY).getInfo().inGrace).toBe(true);
    expect(svc(T0 + 11 * DAY).getInfo().status).toBe('EXPIRED');
  });

  it('detects clock rollback as EXPIRED', () => {
    svc(T0 + 5 * DAY).getInfo(); // trial_start ~ T0+5d, high-water advances
    // now jump the clock back well before trial start
    const info = svc(T0 - 100 * DAY).getInfo();
    expect(info.status).toBe('EXPIRED');
  });
});

describe('activation', () => {
  it('activates with a valid code and becomes LICENSED', () => {
    svc(T0).getInfo(); // establish trial_start at T0
    const s = svc(T0 + 11 * DAY); // now genuinely expired
    expect(s.getInfo().status).toBe('EXPIRED');
    const code = mintCode(MACHINE);
    const info = s.activate(code);
    expect(info.status).toBe('LICENSED');
    // persists across service instances
    expect(svc(T0 + 100 * DAY).getInfo().status).toBe('LICENSED');
  });

  it('rejects a code for a different machine', () => {
    const s = svc(T0);
    const code = mintCode('b'.repeat(32));
    expect(() => s.activate(code)).toThrow(/wrong-machine/);
  });

  it('rejects a tampered/forged signature', () => {
    const s = svc(T0);
    const good = mintCode(MACHINE);
    // flip a char in the payload part
    const tampered = good.replace(/^./, (c) => (c === 'A' ? 'B' : 'A'));
    expect(() => s.activate(tampered)).toThrow(/invalid license/);
  });

  it('honors an expiry: valid before, EXPIRED after', () => {
    const expIso = new Date(T0 + 30 * DAY).toISOString();
    const code = mintCode(MACHINE, expIso);
    // activate while valid
    const before = svc(T0 + 1 * DAY);
    expect(before.activate(code).status).toBe('LICENSED');
    // later, past expiry, the stored code no longer validates
    expect(svc(T0 + 40 * DAY).getInfo().status).toBe('EXPIRED');
  });

  it('rejects a malformed code', () => {
    expect(() => svc(T0).activate('not-a-real-code')).toThrow(/invalid license/);
  });
});
