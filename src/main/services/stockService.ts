/**
 * Stock operations layered on the ledger service. Domain verbs (purchase-in,
 * adjustment) map to the correct movement types and sign conventions, then post
 * through `insertMovement` — the only writer to stock_movements. Read queries
 * join item and user names for display.
 */
import type { DB } from '../db/connection.js';
import { insertMovement, getBalance, reverse, type Balance } from './ledgerService.js';
import type { z } from 'zod';
import type {
  PurchaseInInput,
  AdjustmentInput,
  ReverseMovementInput,
  ListMovementsInput,
  ListBalancesInput,
} from '../../shared/contracts/index.js';
import type {
  MovementType,
  ReasonCode,
  TrackingMode,
  ItemStatus,
} from '../../shared/domain/enums.js';

type PurchaseIn = z.infer<typeof PurchaseInInput>;
type Adjust = z.infer<typeof AdjustmentInput>;
type ReverseIn = z.infer<typeof ReverseMovementInput>;
type ListMoves = z.infer<typeof ListMovementsInput>;
type ListBal = z.infer<typeof ListBalancesInput>;

export interface PostResult {
  movementId: number;
  balance: Balance;
}

function itemLocation(db: DB, itemId: number): number {
  const row = db.prepare('SELECT location_id FROM items WHERE id=?').get(itemId) as
    | { location_id: number }
    | undefined;
  if (!row) throw new Error(`item ${itemId} not found`);
  return row.location_id;
}

export function purchaseIn(db: DB, userId: number, input: PurchaseIn): PostResult {
  const movementId = insertMovement(db, userId, {
    movementType: 'PURCHASE_IN',
    itemId: input.itemId,
    locationId: itemLocation(db, input.itemId),
    piecesDelta: input.pieces,
    grossMgDelta: input.grossMg,
    netMgDelta: input.netMg,
    partyId: input.partyId ?? null,
    notes: input.notes ?? null,
  });
  return { movementId, balance: getBalance(db, input.itemId) };
}

export function adjust(db: DB, userId: number, input: Adjust): PostResult {
  const movementId = insertMovement(db, userId, {
    movementType: 'ADJUSTMENT',
    itemId: input.itemId,
    locationId: itemLocation(db, input.itemId),
    piecesDelta: input.piecesDelta,
    grossMgDelta: input.grossMgDelta,
    netMgDelta: input.netMgDelta,
    reasonCode: input.reasonCode as ReasonCode,
    notes: input.notes ?? null,
  });
  return { movementId, balance: getBalance(db, input.itemId) };
}

export function reverseMovement(db: DB, userId: number, input: ReverseIn): PostResult {
  const itemRow = db
    .prepare('SELECT item_id FROM stock_movements WHERE id=?')
    .get(input.movementId) as { item_id: number } | undefined;
  if (!itemRow) throw new Error(`movement ${input.movementId} not found`);
  const movementId = reverse(
    db,
    userId,
    input.movementId,
    input.reasonCode as ReasonCode,
    input.notes,
  );
  return { movementId, balance: getBalance(db, itemRow.item_id) };
}

interface MovementJoinRow {
  id: number;
  movement_type: MovementType;
  item_id: number;
  item_name: string;
  tag_number: string | null;
  pieces_delta: number;
  gross_mg_delta: number;
  net_mg_delta: number;
  reason_code: ReasonCode | null;
  reverses_movement_id: number | null;
  notes: string | null;
  created_at: string;
  created_by_name: string;
}

export function listMovements(db: DB, input: ListMoves) {
  const where = input.itemId != null ? 'WHERE m.item_id = ?' : '';
  const params: unknown[] = input.itemId != null ? [input.itemId] : [];
  const rows = db
    .prepare(
      `SELECT m.id, m.movement_type, m.item_id, i.name AS item_name, i.tag_number,
              m.pieces_delta, m.gross_mg_delta, m.net_mg_delta, m.reason_code,
              m.reverses_movement_id, m.notes, m.created_at, u.display_name AS created_by_name
       FROM stock_movements m
       JOIN items i ON i.id = m.item_id
       JOIN users u ON u.id = m.created_by
       ${where}
       ORDER BY m.id DESC LIMIT ?`,
    )
    .all(...params, input.limit) as MovementJoinRow[];

  return rows.map((r) => ({
    id: r.id,
    movementType: r.movement_type,
    itemId: r.item_id,
    itemName: r.item_name,
    tagNumber: r.tag_number,
    piecesDelta: r.pieces_delta,
    grossMgDelta: r.gross_mg_delta,
    netMgDelta: r.net_mg_delta,
    reasonCode: r.reason_code,
    reversesMovementId: r.reverses_movement_id,
    notes: r.notes,
    createdAt: r.created_at,
    createdByName: r.created_by_name,
  }));
}

interface BalanceJoinRow {
  item_id: number;
  tag_number: string | null;
  name: string;
  tracking_mode: TrackingMode;
  metal_id: number;
  purity_id: number;
  pieces: number | null;
  gross_mg: number | null;
  net_mg: number | null;
  status: ItemStatus;
}

export function listBalances(db: DB, input: ListBal) {
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (input.search) {
    clauses.push('(i.name LIKE ? OR i.tag_number LIKE ?)');
    params.push(`%${input.search}%`, `%${input.search}%`);
  }
  if (input.nonZeroOnly) {
    clauses.push('(b.pieces != 0 OR b.net_mg != 0)');
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const rows = db
    .prepare(
      `SELECT i.id AS item_id, i.tag_number, i.name, i.tracking_mode, i.metal_id, i.purity_id,
              i.status, b.pieces, b.gross_mg, b.net_mg
       FROM items i
       LEFT JOIN item_balances b ON b.item_id = i.id
       ${where}
       ORDER BY i.id DESC LIMIT ?`,
    )
    .all(...params, input.limit) as BalanceJoinRow[];

  return rows.map((r) => ({
    itemId: r.item_id,
    tagNumber: r.tag_number,
    name: r.name,
    trackingMode: r.tracking_mode,
    metalId: r.metal_id,
    purityId: r.purity_id,
    pieces: r.pieces ?? 0,
    grossMg: r.gross_mg ?? 0,
    netMg: r.net_mg ?? 0,
    status: r.status,
  }));
}
