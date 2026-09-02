/**
 * Item master service. Owns the `items` + `item_costs` tables and produces the
 * ItemDTO the UI consumes (joined with the live ledger balance). Cost is served
 * ONLY to owners — redaction is structural (the query for cost is simply skipped
 * for non-owner callers), not a field-filter that can be forgotten.
 *
 * Creating an item with opening stock posts an OPENING movement through the
 * ledger service, so stock only ever enters via the append-only ledger.
 */
import type { DB } from '../db/connection.js';
import { withAudit } from '../db/audit.js';
import { insertMovement } from './ledgerService.js';
import type { Role } from '../../shared/domain/enums.js';
import type {
  ItemDTOType,
  CreateItemInput,
  UpdateItemInput,
  ListItemsInput,
} from '../../shared/contracts/index.js';
import type { z } from 'zod';

type CreateInput = z.infer<typeof CreateItemInput>;
type UpdateInput = z.infer<typeof UpdateItemInput>;
type ListInput = z.infer<typeof ListItemsInput>;

interface ItemRow {
  id: number;
  tracking_mode: string;
  tag_number: string | null;
  name: string;
  product_type_id: number;
  metal_id: number;
  purity_id: number;
  stone_type_id: number;
  making_type_id: number;
  occasion_id: number | null;
  origin_kind: string;
  source_party_id: number | null;
  gross_mg: number;
  less_mg: number;
  net_mg: number;
  touch_bp: number | null;
  wastage_bp: number;
  making_mode: string;
  making_rate_paisa: number;
  hallmark_number: string | null;
  hallmark_charge_paisa: number;
  status: string;
  location_id: number;
  notes: string | null;
  balance_pieces: number | null;
  balance_net_mg: number | null;
}

interface CostRow {
  intake_rate_paisa_per_gram: number | null;
  labour_paid_paisa: number;
  stone_cost_paisa: number;
  other_cost_paisa: number;
  landed_cost_paisa: number;
}

const SELECT_ITEM = `
  SELECT i.*, b.pieces AS balance_pieces, b.net_mg AS balance_net_mg
  FROM items i
  LEFT JOIN item_balances b ON b.item_id = i.id`;

function costFor(db: DB, itemId: number, role: Role): ItemDTOType['cost'] {
  if (role !== 'OWNER') return null; // structural redaction
  const c = db
    .prepare(
      `SELECT intake_rate_paisa_per_gram, labour_paid_paisa, stone_cost_paisa,
              other_cost_paisa, landed_cost_paisa
       FROM item_costs WHERE item_id=?`,
    )
    .get(itemId) as CostRow | undefined;
  if (!c) return null;
  return {
    intakeRatePaisaPerGram: c.intake_rate_paisa_per_gram,
    labourPaidPaisa: c.labour_paid_paisa,
    stoneCostPaisa: c.stone_cost_paisa,
    otherCostPaisa: c.other_cost_paisa,
    landedCostPaisa: c.landed_cost_paisa,
  };
}

function toDTO(db: DB, row: ItemRow, role: Role): ItemDTOType {
  return {
    id: row.id,
    trackingMode: row.tracking_mode as ItemDTOType['trackingMode'],
    tagNumber: row.tag_number,
    name: row.name,
    productTypeId: row.product_type_id,
    metalId: row.metal_id,
    purityId: row.purity_id,
    stoneTypeId: row.stone_type_id,
    makingTypeId: row.making_type_id,
    occasionId: row.occasion_id,
    originKind: row.origin_kind as ItemDTOType['originKind'],
    sourcePartyId: row.source_party_id,
    grossMg: row.gross_mg,
    lessMg: row.less_mg,
    netMg: row.net_mg,
    touchBp: row.touch_bp,
    wastageBp: row.wastage_bp,
    makingMode: row.making_mode as ItemDTOType['makingMode'],
    makingRatePaisa: row.making_rate_paisa,
    hallmarkNumber: row.hallmark_number,
    hallmarkChargePaisa: row.hallmark_charge_paisa,
    status: row.status as ItemDTOType['status'],
    locationId: row.location_id,
    notes: row.notes,
    balancePieces: row.balance_pieces ?? 0,
    balanceNetMg: row.balance_net_mg ?? 0,
    cost: costFor(db, row.id, role),
  };
}

/** Next sequential tag number, e.g. TAG-000123. Only used when the caller
 * doesn't supply one. Uniqueness is also guaranteed by the UNIQUE constraint. */
function generateTag(db: DB): string {
  const row = db
    .prepare(
      `SELECT tag_number FROM items WHERE tag_number LIKE 'TAG-%'
       ORDER BY id DESC LIMIT 1`,
    )
    .get() as { tag_number: string } | undefined;
  const last = row ? Number(row.tag_number.slice(4)) : 0;
  return `TAG-${String(last + 1).padStart(6, '0')}`;
}

export function listItems(db: DB, role: Role, input: ListInput): ItemDTOType[] {
  const clauses: string[] = [];
  const params: unknown[] = [];
  // Internal lots (raw metal for karigar, old-gold scrap) are never sold or listed
  // as products — they have their own screens. Always exclude them here.
  clauses.push(
    "(i.tag_number IS NULL OR (i.tag_number NOT LIKE 'RAW-%' AND i.tag_number NOT LIKE 'SCRAP-%'))",
  );
  if (input.search) {
    clauses.push('(i.name LIKE ? OR i.tag_number LIKE ?)');
    params.push(`%${input.search}%`, `%${input.search}%`);
  }
  if (input.metalId != null) {
    clauses.push('i.metal_id = ?');
    params.push(input.metalId);
  }
  if (input.status) {
    clauses.push('i.status = ?');
    params.push(input.status);
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const rows = db
    .prepare(`${SELECT_ITEM} ${where} ORDER BY i.id DESC LIMIT ?`)
    .all(...params, input.limit) as ItemRow[];
  return rows.map((r) => toDTO(db, r, role));
}

export function getItem(db: DB, role: Role, id: number): ItemDTOType {
  const row = db.prepare(`${SELECT_ITEM} WHERE i.id=?`).get(id) as ItemRow | undefined;
  if (!row) throw new Error(`item ${id} not found`);
  return toDTO(db, row, role);
}

export function createItem(
  db: DB,
  userId: number,
  role: Role,
  input: CreateInput,
): { id: number; tagNumber: string } {
  return withAudit(db, userId, (ctx) => {
    const tag = input.tagNumber ?? generateTag(db);
    const info = db
      .prepare(
        `INSERT INTO items
          (tracking_mode, tag_number, name, product_type_id, metal_id, purity_id, stone_type_id,
           making_type_id, occasion_id, origin_kind, source_party_id, gross_mg, less_mg, net_mg,
           touch_bp, wastage_bp, making_mode, making_rate_paisa, hallmark_number,
           hallmark_charge_paisa, status, location_id, notes, created_by)
         VALUES
          (@tracking_mode, @tag_number, @name, @product_type_id, @metal_id, @purity_id, @stone_type_id,
           @making_type_id, @occasion_id, @origin_kind, @source_party_id, @gross_mg, @less_mg, @net_mg,
           @touch_bp, @wastage_bp, @making_mode, @making_rate_paisa, @hallmark_number,
           @hallmark_charge_paisa, 'IN_STOCK', @location_id, @notes, @created_by)`,
      )
      .run({
        tracking_mode: input.trackingMode,
        tag_number: tag,
        name: input.name,
        product_type_id: input.productTypeId,
        metal_id: input.metalId,
        purity_id: input.purityId,
        stone_type_id: input.stoneTypeId,
        making_type_id: input.makingTypeId,
        occasion_id: input.occasionId ?? null,
        origin_kind: input.originKind,
        source_party_id: input.sourcePartyId ?? null,
        gross_mg: input.grossMg,
        less_mg: input.lessMg,
        net_mg: input.netMg,
        touch_bp: input.touchBp ?? null,
        wastage_bp: input.wastageBp,
        making_mode: input.makingMode,
        making_rate_paisa: input.makingRatePaisa,
        hallmark_number: input.hallmarkNumber ?? null,
        hallmark_charge_paisa: input.hallmarkChargePaisa,
        location_id: input.locationId,
        notes: input.notes ?? null,
        created_by: userId,
      });
    const id = Number(info.lastInsertRowid);
    ctx.record({ table: 'items', rowPk: id, action: 'INSERT', changes: { name: input.name, tag } });

    // Cost is owner-only.
    if (role === 'OWNER' && input.cost) {
      upsertCost(db, userId, id, input.cost);
    }

    // Opening stock (optional). ITEM mode moves exactly one piece; LOT can open
    // with a pieces count. Weight posted is this item's net/gross.
    if (input.openingPieces > 0) {
      const pieces = input.trackingMode === 'ITEM' ? 1 : input.openingPieces;
      insertMovement(
        db,
        userId,
        {
          movementType: 'OPENING',
          itemId: id,
          locationId: input.locationId,
          piecesDelta: pieces,
          grossMgDelta: input.grossMg * pieces,
          netMgDelta: input.netMg * pieces,
        },
        ctx,
      );
    }

    return { id, tagNumber: tag };
  });
}

export function updateItem(
  db: DB,
  userId: number,
  role: Role,
  input: UpdateInput,
): ItemDTOType {
  return withAudit(db, userId, (ctx) => {
    const existing = db.prepare('SELECT id FROM items WHERE id=?').get(input.id);
    if (!existing) throw new Error(`item ${input.id} not found`);

    db.prepare(
      `UPDATE items SET
         name=@name, product_type_id=@product_type_id, metal_id=@metal_id, purity_id=@purity_id,
         stone_type_id=@stone_type_id, making_type_id=@making_type_id, occasion_id=@occasion_id,
         origin_kind=@origin_kind, source_party_id=@source_party_id, gross_mg=@gross_mg,
         less_mg=@less_mg, net_mg=@net_mg, touch_bp=@touch_bp, wastage_bp=@wastage_bp,
         making_mode=@making_mode, making_rate_paisa=@making_rate_paisa,
         hallmark_number=@hallmark_number, hallmark_charge_paisa=@hallmark_charge_paisa,
         location_id=@location_id, notes=@notes
       WHERE id=@id`,
    ).run({
      id: input.id,
      name: input.name,
      product_type_id: input.productTypeId,
      metal_id: input.metalId,
      purity_id: input.purityId,
      stone_type_id: input.stoneTypeId,
      making_type_id: input.makingTypeId,
      occasion_id: input.occasionId ?? null,
      origin_kind: input.originKind,
      source_party_id: input.sourcePartyId ?? null,
      gross_mg: input.grossMg,
      less_mg: input.lessMg,
      net_mg: input.netMg,
      touch_bp: input.touchBp ?? null,
      wastage_bp: input.wastageBp,
      making_mode: input.makingMode,
      making_rate_paisa: input.makingRatePaisa,
      hallmark_number: input.hallmarkNumber ?? null,
      hallmark_charge_paisa: input.hallmarkChargePaisa,
      location_id: input.locationId,
      notes: input.notes ?? null,
    });
    ctx.record({ table: 'items', rowPk: input.id, action: 'UPDATE', changes: { name: input.name } });

    if (role === 'OWNER' && input.cost) {
      upsertCost(db, userId, input.id, input.cost);
    }

    return getItem(db, role, input.id);
  });
}

function upsertCost(
  db: DB,
  userId: number,
  itemId: number,
  cost: Partial<{
    intakeRatePaisaPerGram: number | null;
    labourPaidPaisa: number;
    stoneCostPaisa: number;
    otherCostPaisa: number;
    landedCostPaisa: number;
  }>,
): void {
  db.prepare(
    `INSERT INTO item_costs
      (item_id, intake_rate_paisa_per_gram, labour_paid_paisa, stone_cost_paisa,
       other_cost_paisa, landed_cost_paisa, updated_by)
     VALUES (@item_id, @intake, @labour, @stone, @other, @landed, @user)
     ON CONFLICT(item_id) DO UPDATE SET
       intake_rate_paisa_per_gram=@intake, labour_paid_paisa=@labour, stone_cost_paisa=@stone,
       other_cost_paisa=@other, landed_cost_paisa=@landed,
       updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'), updated_by=@user`,
  ).run({
    item_id: itemId,
    intake: cost.intakeRatePaisaPerGram ?? null,
    labour: cost.labourPaidPaisa ?? 0,
    stone: cost.stoneCostPaisa ?? 0,
    other: cost.otherCostPaisa ?? 0,
    landed: cost.landedCostPaisa ?? 0,
    user: userId,
  });
}
