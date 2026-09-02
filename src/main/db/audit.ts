/**
 * Tamper-evident audit trail. Every mutation runs inside `withAudit`, which
 * opens a transaction and provides a `record()` sink; on commit the recorded
 * entries are written as a SHA-256 hash chain (each row's hash folds in the
 * previous row's hash). Editing or deleting any audit row later breaks every
 * subsequent hash, which `verifyAuditChain` detects.
 *
 * The chain is computed in the app layer (SQLite triggers can't do SHA-256);
 * `audit_log` itself is protected from UPDATE/DELETE by triggers.
 */
import { createHash } from 'node:crypto';
import type { DB } from './connection.js';

const GENESIS = '0'.repeat(64);

export type AuditAction =
  | 'INSERT'
  | 'UPDATE'
  | 'DELETE'
  | 'LOGIN'
  | 'OVERRIDE'
  | 'FINALIZE'
  | 'REBUILD';

export interface AuditEntry {
  table: string;
  rowPk: number;
  action: AuditAction;
  /** Field-level diff or context payload; serialized as-is. */
  changes: unknown;
}

function hashRow(
  prevHash: string,
  e: AuditEntry,
  userId: number,
  at: string,
  changesJson: string,
): string {
  return createHash('sha256')
    .update(`${prevHash}␟${e.table}␟${e.rowPk}␟${e.action}␟${changesJson}␟${userId}␟${at}`)
    .digest('hex');
}

function lastHash(db: DB): string {
  const row = db.prepare('SELECT row_hash FROM audit_log ORDER BY id DESC LIMIT 1').get() as
    | { row_hash: string }
    | undefined;
  return row?.row_hash ?? GENESIS;
}

/** ISO-8601 UTC to millisecond precision, matching the SQLite default format. */
function nowIso(): string {
  return new Date().toISOString().replace(/\.(\d{3})Z$/, '.$1Z');
}

export interface AuditContext {
  record(entry: AuditEntry): void;
}

/**
 * Run `fn` inside a single transaction with an audit sink. All DB work plus the
 * audit rows commit atomically; if `fn` throws, nothing is written.
 */
export function withAudit<T>(db: DB, userId: number, fn: (ctx: AuditContext) => T): T {
  const pending: AuditEntry[] = [];
  const ctx: AuditContext = { record: (e) => pending.push(e) };

  const insertAudit = db.prepare(
    `INSERT INTO audit_log (prev_hash, row_hash, table_name, row_pk, action, changes_json, user_id, at)
     VALUES (@prev_hash, @row_hash, @table_name, @row_pk, @action, @changes_json, @user_id, @at)`,
  );

  const tx = db.transaction(() => {
    const result = fn(ctx);
    let prev = lastHash(db);
    for (const e of pending) {
      const at = nowIso();
      const changesJson = JSON.stringify(e.changes ?? null);
      const rowHash = hashRow(prev, e, userId, at, changesJson);
      insertAudit.run({
        prev_hash: prev,
        row_hash: rowHash,
        table_name: e.table,
        row_pk: e.rowPk,
        action: e.action,
        changes_json: changesJson,
        user_id: userId,
        at,
      });
      prev = rowHash;
    }
    return result;
  });

  return tx();
}

export interface ChainVerification {
  ok: boolean;
  /** id of the first row whose hash does not match; null if the chain is intact. */
  brokenAtId: number | null;
  checked: number;
}

/** Re-walk the whole chain and confirm every row_hash still recomputes. */
export function verifyAuditChain(db: DB): ChainVerification {
  const rows = db
    .prepare(
      `SELECT id, prev_hash, row_hash, table_name, row_pk, action, changes_json, user_id, at
       FROM audit_log ORDER BY id ASC`,
    )
    .all() as Array<{
    id: number;
    prev_hash: string;
    row_hash: string;
    table_name: string;
    row_pk: number;
    action: AuditAction;
    changes_json: string;
    user_id: number;
    at: string;
  }>;

  let prev = GENESIS;
  for (const r of rows) {
    const expected = hashRow(
      prev,
      { table: r.table_name, rowPk: r.row_pk, action: r.action, changes: undefined },
      r.user_id,
      r.at,
      r.changes_json,
    );
    if (r.prev_hash !== prev || r.row_hash !== expected) {
      return { ok: false, brokenAtId: r.id, checked: rows.length };
    }
    prev = r.row_hash;
  }
  return { ok: true, brokenAtId: null, checked: rows.length };
}
