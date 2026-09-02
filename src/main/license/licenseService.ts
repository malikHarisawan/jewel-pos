/**
 * Offline licensing. Runs in the main process (Node crypto + DB + system clock).
 * See docs/licensing.md for the model. Status is derived, never trusted from the
 * renderer.
 */
import { createHash, createPublicKey, verify as edVerify } from 'node:crypto';
import { execSync } from 'node:child_process';
import { hostname, platform, cpus } from 'node:os';
import type { DB } from '../db/connection.js';
import {
  TRIAL_DAYS,
  GRACE_DAYS,
  parseCode,
  b64urlDecode,
  type LicenseStatus,
} from '../../shared/license/format.js';
import { LICENSE_PUBLIC_KEY_B64URL } from '../../shared/license/publicKey.js';

const DAY_MS = 24 * 60 * 60 * 1000;
/** Clock skew tolerance for rollback detection. */
const SKEW_MS = 60 * 60 * 1000;

/** Stable, opaque per-machine fingerprint. */
export function computeMachineId(): string {
  let raw: string;
  try {
    if (platform() === 'win32') {
      const out = execSync(
        'reg query "HKLM\\SOFTWARE\\Microsoft\\Cryptography" /v MachineGuid',
        { stdio: ['ignore', 'pipe', 'ignore'] },
      ).toString();
      const m = out.match(/MachineGuid\s+REG_SZ\s+([0-9a-fA-F-]+)/);
      raw = m ? m[1] : `${hostname()}|${platform()}`;
    } else {
      raw = `${hostname()}|${platform()}|${cpus()[0]?.model ?? ''}`;
    }
  } catch {
    raw = `${hostname()}|${platform()}|${cpus()[0]?.model ?? ''}`;
  }
  return createHash('sha256').update(raw).digest('hex').slice(0, 32);
}

export interface LicenseInfo {
  status: LicenseStatus;
  machineId: string;
  /** Days remaining in trial+grace (0 when expired/licensed). */
  daysLeft: number;
  /** True while in the GRACE window. */
  inGrace: boolean;
  /** License expiry ISO if the active code has one. */
  licensedUntil: string | null;
}

export class LicenseService {
  private machineId: string;
  /** Public key override (base64url SPKI). Tests inject their own; production
   * uses the embedded key. */
  private publicKeyB64: string;

  constructor(
    private db: DB,
    private now: () => number = () => Date.now(),
    machineId?: string,
    publicKeyB64?: string,
  ) {
    this.machineId = machineId ?? computeMachineId();
    this.publicKeyB64 = publicKeyB64 ?? LICENSE_PUBLIC_KEY_B64URL;
  }

  private hasKey(): boolean {
    return this.publicKeyB64 !== 'REPLACE_ME_WITH_KEYGEN_OUTPUT';
  }

  getMachineId(): string {
    return this.machineId;
  }

  /** Ensure the single license row exists; set trial_start on first boot. */
  private ensureRow(): { trial_start: string; license_code: string | null; high_water_mark: string } {
    let row = this.db
      .prepare('SELECT trial_start, license_code, high_water_mark FROM license WHERE id=1')
      .get() as { trial_start: string; license_code: string | null; high_water_mark: string } | undefined;
    if (!row) {
      const nowIso = new Date(this.now()).toISOString();
      this.db
        .prepare(
          `INSERT INTO license (id, machine_id, trial_start, license_code, high_water_mark)
           VALUES (1, ?, ?, NULL, ?)`,
        )
        .run(this.machineId, nowIso, nowIso);
      row = { trial_start: nowIso, license_code: null, high_water_mark: nowIso };
    }
    return row;
  }

  /** Advance the anti-rollback mark; return true if the clock looks rolled back. */
  private updateHighWater(current: string): boolean {
    const now = this.now();
    const mark = Date.parse(current);
    if (now + SKEW_MS < mark) return true; // clock moved backwards beyond skew
    if (now > mark) {
      this.db
        .prepare(`UPDATE license SET high_water_mark=?, updated_at=? WHERE id=1`)
        .run(new Date(now).toISOString(), new Date(now).toISOString());
    }
    return false;
  }

  /** Verify a license code's signature + machine binding + expiry. */
  verifyCode(code: string): { valid: boolean; reason?: string; exp?: string | null } {
    if (!this.hasKey()) return { valid: false, reason: 'no-public-key' };
    let parsed;
    try {
      parsed = parseCode(code);
    } catch {
      return { valid: false, reason: 'malformed' };
    }
    try {
      const pubKey = createPublicKey({
        key: Buffer.from(b64urlDecode(this.publicKeyB64)),
        format: 'der',
        type: 'spki',
      });
      const ok = edVerify(null, Buffer.from(parsed.payloadBytes), pubKey, Buffer.from(parsed.signature));
      if (!ok) return { valid: false, reason: 'bad-signature' };
    } catch {
      return { valid: false, reason: 'bad-signature' };
    }
    if (parsed.payload.machineId !== this.machineId) {
      return { valid: false, reason: 'wrong-machine' };
    }
    if (parsed.payload.exp && Date.parse(parsed.payload.exp) < this.now()) {
      return { valid: false, reason: 'expired', exp: parsed.payload.exp };
    }
    return { valid: true, exp: parsed.payload.exp ?? null };
  }

  /** Store a verified code, activating the license. Throws if invalid. */
  activate(code: string): LicenseInfo {
    const res = this.verifyCode(code);
    if (!res.valid) throw new Error(`invalid license code (${res.reason})`);
    this.ensureRow();
    this.db.prepare(`UPDATE license SET license_code=?, updated_at=? WHERE id=1`).run(
      code.trim(),
      new Date(this.now()).toISOString(),
    );
    return this.getInfo();
  }

  getInfo(): LicenseInfo {
    const row = this.ensureRow();
    const rolledBack = this.updateHighWater(row.high_water_mark);

    // Active license takes precedence (unless its own code expired).
    if (row.license_code) {
      const res = this.verifyCode(row.license_code);
      if (res.valid) {
        return {
          status: 'LICENSED',
          machineId: this.machineId,
          daysLeft: 0,
          inGrace: false,
          licensedUntil: res.exp ?? null,
        };
      }
      // stored code no longer valid (expired / machine changed) → fall through to EXPIRED
      return {
        status: 'EXPIRED',
        machineId: this.machineId,
        daysLeft: 0,
        inGrace: false,
        licensedUntil: res.exp ?? null,
      };
    }

    if (rolledBack) {
      return { status: 'EXPIRED', machineId: this.machineId, daysLeft: 0, inGrace: false, licensedUntil: null };
    }

    const elapsedDays = (this.now() - Date.parse(row.trial_start)) / DAY_MS;
    if (elapsedDays < TRIAL_DAYS) {
      return {
        status: 'TRIAL',
        machineId: this.machineId,
        daysLeft: Math.max(0, Math.ceil(TRIAL_DAYS - elapsedDays)),
        inGrace: false,
        licensedUntil: null,
      };
    }
    if (elapsedDays < TRIAL_DAYS + GRACE_DAYS) {
      return {
        status: 'GRACE',
        machineId: this.machineId,
        daysLeft: Math.max(0, Math.ceil(TRIAL_DAYS + GRACE_DAYS - elapsedDays)),
        inGrace: true,
        licensedUntil: null,
      };
    }
    return { status: 'EXPIRED', machineId: this.machineId, daysLeft: 0, inGrace: false, licensedUntil: null };
  }
}
