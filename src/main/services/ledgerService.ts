/**
 * The ONLY module allowed to INSERT into stock_movements. Every other part of
 * the app posts stock changes through here so the dual-unit ledger, the
 * materialized balance, and the audit trail stay in lockstep.
 *
 * Corrections are never edits: `reverse()` posts a mirror-image movement that
 * cancels an earlier one, preserving the append-only history.
 */
import type { DB } from '../db/connection.js';
import { withAudit, type AuditContext } from '../db/audit.js';
import type { MovementType, ReasonCode } from '../../shared/domain/enums.js';

export interface PostMovementInput {
  movementType: MovementType;
  itemId: number;
  locationId: number;
  piecesDelta: number;
  grossMgDelta: number;
  netMgDelta: number;
  documentId?: number | null;
  documentLineId?: number | null;
  partyId?: number | null;
  transferGroup?: string | null;
  reasonCode?: ReasonCode | null;
  reversesMovementId?: number | null;
  notes?: string | null;
}

export interface Balance {
  pieces: number;
  grossMg: number;
  netMg: number;
}

const INSERT_MOVEMENT = `
  INSERT INTO stock_movements
    (movement_type, item_id, location_id, pieces_delta, gross_mg_delta, net_mg_delta,
     document_id, document_line_id, party_id, transfer_group, reason_code,
     reverses_movement_id, notes, created_by)
  VALUES
    (@movement_type, @item_id, @location_id, @pieces_delta, @gross_mg_delta, @net_mg_delta,
     @document_id, @document_line_id, @party_id, @transfer_group, @reason_code,
     @reverses_movement_id, @notes, @created_by)`;

/**
 * Insert one movement (balance + guards are enforced by DB triggers) and record
 * an audit entry. Callers pass their own AuditContext when this runs inside a
 * larger transaction (e.g. invoice finalize); otherwise a standalone
 * `withAudit` wraps it.
 */
export function insertMovement(
  db: DB,
  userId: number,
  input: PostMovementInput,
  ctx?: AuditContext,
): number {
  const doInsert = (audit: AuditContext): number => {
    const info = db.prepare(INSERT_MOVEMENT).run({
      movement_type: input.movementType,
      item_id: input.itemId,
      location_id: input.locationId,
      pieces_delta: input.piecesDelta,
      gross_mg_delta: input.grossMgDelta,
      net_mg_delta: input.netMgDelta,
      document_id: input.documentId ?? null,
      document_line_id: input.documentLineId ?? null,
      party_id: input.partyId ?? null,
      transfer_group: input.transferGroup ?? null,
      reason_code: input.reasonCode ?? null,
      reverses_movement_id: input.reversesMovementId ?? null,
      notes: input.notes ?? null,
      created_by: userId,
    });
    const id = Number(info.lastInsertRowid);
    audit.record({ table: 'stock_movements', rowPk: id, action: 'INSERT', changes: input });
    return id;
  };

  if (ctx) return doInsert(ctx);
  return withAudit(db, userId, doInsert);
}

export function getBalance(db: DB, itemId: number): Balance {
  const row = db
    .prepare('SELECT pieces, gross_mg, net_mg FROM item_balances WHERE item_id=?')
    .get(itemId) as { pieces: number; gross_mg: number; net_mg: number } | undefined;
  return {
    pieces: row?.pieces ?? 0,
    grossMg: row?.gross_mg ?? 0,
    netMg: row?.net_mg ?? 0,
  };
}

/** Post a reversing movement that negates an earlier one. */
export function reverse(
  db: DB,
  userId: number,
  movementId: number,
  reasonCode: ReasonCode,
  notes?: string,
): number {
  const orig = db
    .prepare(
      `SELECT movement_type, item_id, location_id, pieces_delta, gross_mg_delta, net_mg_delta
       FROM stock_movements WHERE id=?`,
    )
    .get(movementId) as
    | {
        movement_type: MovementType;
        item_id: number;
        location_id: number;
        pieces_delta: number;
        gross_mg_delta: number;
        net_mg_delta: number;
      }
    | undefined;
  if (!orig) throw new Error(`movement ${movementId} not found`);

  return insertMovement(db, userId, {
    movementType: 'ADJUSTMENT',
    itemId: orig.item_id,
    locationId: orig.location_id,
    piecesDelta: -orig.pieces_delta,
    grossMgDelta: -orig.gross_mg_delta,
    netMgDelta: -orig.net_mg_delta,
    reasonCode,
    reversesMovementId: movementId,
    notes: notes ?? `Reversal of movement ${movementId}`,
  });
}

/**
 * Recompute item_balances from the ledger and report any drift. Called at backup
 * time; the ledger is authoritative, so on mismatch the table is corrected.
 */
export function rebuildBalances(db: DB, userId: number): { corrected: number } {
  return withAudit(db, userId, (ctx) => {
    const before = db.prepare('SELECT item_id, pieces, gross_mg, net_mg FROM item_balances').all() as Array<{
      item_id: number;
      pieces: number;
      gross_mg: number;
      net_mg: number;
    }>;
    const beforeMap = new Map(before.map((b) => [b.item_id, b]));

    db.prepare('DELETE FROM item_balances').run();
    db.prepare(
      `INSERT INTO item_balances (item_id, pieces, gross_mg, net_mg, last_movement_id)
       SELECT item_id, SUM(pieces_delta), SUM(gross_mg_delta), SUM(net_mg_delta), MAX(id)
       FROM stock_movements GROUP BY item_id`,
    ).run();

    const after = db.prepare('SELECT item_id, pieces, gross_mg, net_mg FROM item_balances').all() as Array<{
      item_id: number;
      pieces: number;
      gross_mg: number;
      net_mg: number;
    }>;
    let corrected = 0;
    for (const a of after) {
      const b = beforeMap.get(a.item_id);
      if (!b || b.pieces !== a.pieces || b.gross_mg !== a.gross_mg || b.net_mg !== a.net_mg) {
        corrected++;
      }
    }
    ctx.record({ table: 'item_balances', rowPk: 0, action: 'REBUILD', changes: { corrected } });
    return { corrected };
  });
}
