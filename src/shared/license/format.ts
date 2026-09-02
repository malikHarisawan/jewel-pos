/**
 * License code format (pure — no Node/crypto here, so it stays inside the shared
 * boundary). A code is `base64url(payloadJson).base64url(signature)`. Signing and
 * verifying (Ed25519) happen in the main process where Node `crypto` lives.
 */

export interface LicensePayload {
  /** Machine this code is valid for. */
  machineId: string;
  /** Optional expiry (ISO date). null/absent = perpetual. */
  exp?: string | null;
  /** Issued-at ISO date. */
  iss: string;
}

export type LicenseStatus = 'TRIAL' | 'GRACE' | 'LICENSED' | 'EXPIRED';

/** Trial/grace lengths in days (defaults; change here to adjust the policy). */
export const TRIAL_DAYS = 7;
export const GRACE_DAYS = 3;

export function b64urlEncode(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  const b64 = typeof btoa === 'function' ? btoa(bin) : Buffer.from(bin, 'binary').toString('base64');
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function b64urlDecode(s: string): Uint8Array {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/');
  const bin =
    typeof atob === 'function' ? atob(b64) : Buffer.from(b64, 'base64').toString('binary');
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

const enc = new TextEncoder();
const dec = new TextDecoder();

export function encodePayload(payload: LicensePayload): Uint8Array {
  return enc.encode(JSON.stringify(payload));
}

export function buildCode(payloadBytes: Uint8Array, signature: Uint8Array): string {
  return `${b64urlEncode(payloadBytes)}.${b64urlEncode(signature)}`;
}

export interface ParsedCode {
  payloadBytes: Uint8Array;
  signature: Uint8Array;
  payload: LicensePayload;
}

/** Split a code into its parts and parse the payload JSON. Throws on malformed. */
export function parseCode(code: string): ParsedCode {
  const trimmed = code.trim();
  const dot = trimmed.indexOf('.');
  if (dot < 1) throw new Error('malformed license code');
  const payloadBytes = b64urlDecode(trimmed.slice(0, dot));
  const signature = b64urlDecode(trimmed.slice(dot + 1));
  const payload = JSON.parse(dec.decode(payloadBytes)) as LicensePayload;
  if (!payload.machineId || !payload.iss) throw new Error('invalid license payload');
  return { payloadBytes, signature, payload };
}

/** Format a machine id into dictation-friendly groups (e.g. 9F3A-1B7C-...). */
export function formatMachineId(id: string): string {
  return (id.match(/.{1,4}/g) ?? [id]).join('-').toUpperCase();
}
