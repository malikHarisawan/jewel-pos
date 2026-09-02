/**
 * Metal rate management + live item price quoting.
 *
 * Rates are append-only (a wrong entry is corrected by entering a new one; the
 * DB trigger blocks UPDATE/DELETE). "Today's rate" is the latest row per purity.
 * Quoting reuses the pure pricing engine so an item's on-screen price matches
 * exactly what it will bill for at sale time.
 */
import type { DB } from '../db/connection.js';
import { withAudit } from '../db/audit.js';
import { normalizeRateToPaisaPerGram, type RateBasis } from '../../shared/units/index.js';
import { priceSaleLine, type TaxConfig } from '../../shared/pricing/engine.js';
import type { z } from 'zod';
import type {
  EnterRateInput,
  RateHistoryInput,
  QuoteItemsInput,
} from '../../shared/contracts/index.js';
import type { TaxBase } from '../../shared/domain/enums.js';

type EnterInput = z.infer<typeof EnterRateInput>;
type HistoryInput = z.infer<typeof RateHistoryInput>;
type QuoteInput = z.infer<typeof QuoteItemsInput>;

function settingsTaxConfig(db: DB): TaxConfig {
  const get = (k: string, d: string) =>
    (db.prepare('SELECT value FROM app_settings WHERE key=?').get(k) as { value: string } | undefined)
      ?.value ?? d;
  return {
    rateBp: Number(get('tax_rate_bp', '0')),
    base: get('tax_base', 'TOTAL') as TaxBase,
  };
}

function tolaMg(db: DB): number {
  const v = (db.prepare(`SELECT value FROM app_settings WHERE key='tola_mg'`).get() as
    | { value: string }
    | undefined)?.value;
  return v ? Number(v) : 11_664;
}

export function enterRate(db: DB, userId: number, input: EnterInput) {
  return withAudit(db, userId, (ctx) => {
    const ratePerGram = normalizeRateToPaisaPerGram(
      input.enteredValuePaisa,
      input.enteredBasis as RateBasis,
      tolaMg(db),
    );
    const info = db
      .prepare(
        `INSERT INTO metal_rates (purity_id, rate_paisa_per_gram, entered_value_paisa, entered_basis, entered_by)
         VALUES (?,?,?,?,?)`,
      )
      .run(input.purityId, ratePerGram, input.enteredValuePaisa, input.enteredBasis, userId);
    const id = Number(info.lastInsertRowid);
    ctx.record({
      table: 'metal_rates',
      rowPk: id,
      action: 'INSERT',
      changes: { purityId: input.purityId, ratePerGram },
    });
    return getRate(db, id);
  });
}

function getRate(db: DB, id: number) {
  const r = db
    .prepare(
      `SELECT r.id, r.purity_id, r.rate_paisa_per_gram, r.entered_value_paisa, r.entered_basis,
              r.effective_at, u.display_name AS entered_by_name
       FROM metal_rates r JOIN users u ON u.id = r.entered_by WHERE r.id=?`,
    )
    .get(id) as {
    id: number;
    purity_id: number;
    rate_paisa_per_gram: number;
    entered_value_paisa: number;
    entered_basis: RateBasis;
    effective_at: string;
    entered_by_name: string;
  };
  return {
    id: r.id,
    purityId: r.purity_id,
    ratePaisaPerGram: r.rate_paisa_per_gram,
    enteredValuePaisa: r.entered_value_paisa,
    enteredBasis: r.entered_basis,
    effectiveAt: r.effective_at,
    enteredByName: r.entered_by_name,
  };
}

/** Latest rate for every active purity (null where none entered yet). */
export function latestRates(db: DB) {
  const rows = db
    .prepare(
      `SELECT p.id AS purity_id, p.label, p.metal_id,
              lr.rate_paisa_per_gram, lr.effective_at
       FROM purities p
       LEFT JOIN (
         SELECT purity_id, rate_paisa_per_gram, effective_at
         FROM metal_rates
         WHERE id IN (SELECT MAX(id) FROM metal_rates GROUP BY purity_id)
       ) lr ON lr.purity_id = p.id
       WHERE p.is_active = 1
       ORDER BY p.metal_id, p.sort_order`,
    )
    .all() as Array<{
    purity_id: number;
    label: string;
    metal_id: number;
    rate_paisa_per_gram: number | null;
    effective_at: string | null;
  }>;
  return rows.map((r) => ({
    purityId: r.purity_id,
    label: r.label,
    metalId: r.metal_id,
    ratePaisaPerGram: r.rate_paisa_per_gram,
    effectiveAt: r.effective_at,
  }));
}

export function rateHistory(db: DB, input: HistoryInput) {
  const where = input.purityId != null ? 'WHERE r.purity_id = ?' : '';
  const params: unknown[] = input.purityId != null ? [input.purityId] : [];
  const rows = db
    .prepare(
      `SELECT r.id, r.purity_id, r.rate_paisa_per_gram, r.entered_value_paisa, r.entered_basis,
              r.effective_at, u.display_name AS entered_by_name
       FROM metal_rates r JOIN users u ON u.id = r.entered_by
       ${where}
       ORDER BY r.id DESC LIMIT ?`,
    )
    .all(...params, input.limit) as Array<{
    id: number;
    purity_id: number;
    rate_paisa_per_gram: number;
    entered_value_paisa: number;
    entered_basis: RateBasis;
    effective_at: string;
    entered_by_name: string;
  }>;
  return rows.map((r) => ({
    id: r.id,
    purityId: r.purity_id,
    ratePaisaPerGram: r.rate_paisa_per_gram,
    enteredValuePaisa: r.entered_value_paisa,
    enteredBasis: r.entered_basis,
    effectiveAt: r.effective_at,
    enteredByName: r.entered_by_name,
  }));
}

interface ItemPricingRow {
  id: number;
  purity_id: number;
  net_mg: number;
  wastage_bp: number;
  making_mode: 'PER_GRAM' | 'FIXED' | 'PCT_OF_METAL';
  making_rate_paisa: number;
  hallmark_charge_paisa: number;
}

/** Price a batch of items at their purity's latest rate. Items with no rate yet
 * come back with hasRate=false and zeroed money (the UI shows "no rate"). */
export function quoteItems(db: DB, input: QuoteInput) {
  if (input.itemIds.length === 0) return [];
  const tax = settingsTaxConfig(db);
  const latest = new Map<number, number>();
  for (const r of latestRates(db)) {
    if (r.ratePaisaPerGram != null) latest.set(r.purityId, r.ratePaisaPerGram);
  }

  const placeholders = input.itemIds.map(() => '?').join(',');
  const items = db
    .prepare(
      `SELECT id, purity_id, net_mg, wastage_bp, making_mode, making_rate_paisa, hallmark_charge_paisa
       FROM items WHERE id IN (${placeholders})`,
    )
    .all(...input.itemIds) as ItemPricingRow[];

  const stoneStmt = db.prepare(
    `SELECT total_carat_c, rate_paisa_per_carat FROM item_stones WHERE item_id=?`,
  );

  return items.map((it) => {
    const ratePaisaPerGram = latest.get(it.purity_id) ?? null;
    if (ratePaisaPerGram == null) {
      return {
        itemId: it.id,
        hasRate: false,
        ratePaisaPerGram: null,
        metalValuePaisa: 0,
        makingValuePaisa: 0,
        wastageValuePaisa: 0,
        stoneValuePaisa: 0,
        hallmarkChargePaisa: it.hallmark_charge_paisa,
        taxPaisa: 0,
        totalPaisa: 0,
      };
    }
    const stones = (stoneStmt.all(it.id) as Array<{
      total_carat_c: number;
      rate_paisa_per_carat: number;
    }>).map((s) => ({ totalCaratC: s.total_carat_c, ratePaisaPerCarat: s.rate_paisa_per_carat }));

    const b = priceSaleLine(
      {
        netMg: it.net_mg,
        wastageBp: it.wastage_bp,
        making: { mode: it.making_mode, ratePaisa: it.making_rate_paisa },
        stones,
        hallmarkChargePaisa: it.hallmark_charge_paisa,
      },
      { purityId: it.purity_id, metalRateId: 0, ratePaisaPerGram },
      { paisa: 0 },
      tax,
    );
    return {
      itemId: it.id,
      hasRate: true,
      ratePaisaPerGram,
      metalValuePaisa: b.metalValuePaisa,
      makingValuePaisa: b.makingValuePaisa,
      wastageValuePaisa: b.wastageValuePaisa,
      stoneValuePaisa: b.stoneValuePaisa,
      hallmarkChargePaisa: b.hallmarkChargePaisa,
      taxPaisa: b.taxPaisa,
      totalPaisa: b.lineTotalPaisa,
    };
  });
}

/** Price an item at an OVERRIDDEN net weight — used for bulk (LOT) items where
 * the counter sells a chosen number of grams from a pool. Uses the item's making
 * rate and today's rate; no hallmark (a per-piece charge doesn't apply to a
 * weight cut). */
export function quoteWeight(db: DB, itemId: number, netMg: number) {
  const it = db
    .prepare(
      `SELECT id, purity_id, wastage_bp, making_mode, making_rate_paisa FROM items WHERE id=?`,
    )
    .get(itemId) as
    | { id: number; purity_id: number; wastage_bp: number; making_mode: 'PER_GRAM' | 'FIXED' | 'PCT_OF_METAL'; making_rate_paisa: number }
    | undefined;
  if (!it) throw new Error(`item ${itemId} not found`);

  const ratePaisaPerGram =
    latestRates(db).find((r) => r.purityId === it.purity_id)?.ratePaisaPerGram ?? null;
  if (ratePaisaPerGram == null) {
    return { itemId, hasRate: false, ratePaisaPerGram: null, totalPaisa: 0 };
  }
  const b = priceSaleLine(
    {
      netMg,
      wastageBp: it.wastage_bp,
      making: { mode: it.making_mode, ratePaisa: it.making_rate_paisa },
      stones: [],
      hallmarkChargePaisa: 0,
    },
    { purityId: it.purity_id, metalRateId: 0, ratePaisaPerGram },
    { paisa: 0 },
    settingsTaxConfig(db),
  );
  return { itemId, hasRate: true, ratePaisaPerGram, totalPaisa: b.lineTotalPaisa };
}
