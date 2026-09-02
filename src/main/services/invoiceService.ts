/**
 * Sale-invoice orchestration. Finalizing an invoice is a single transaction:
 *   1. issue a gapless document number,
 *   2. re-price every line with the pure engine and freeze the split onto the row,
 *   3. post SALE_OUT ledger movements for item/lot lines,
 *   4. for old-gold lines, create/append a scrap LOT item and post EXCHANGE_IN,
 *   5. write payments,
 *   6. verify header totals == sum of lines and payments cover the total,
 *   7. flip status DRAFT -> FINAL.
 * Anything throwing rolls the whole thing back — no partial invoice can exist.
 */
import type { DB } from '../db/connection.js';
import { withAudit } from '../db/audit.js';
import { insertMovement } from './ledgerService.js';
import {
  priceSaleLine,
  priceOldGoldLine,
  totalDocument,
  type LineBreakdown,
  type RateSnapshot,
  type TaxConfig,
} from '../../shared/pricing/engine.js';
import type { MakingMode, PaymentMethod, Role } from '../../shared/domain/enums.js';

export interface SaleLineInput {
  itemId: number;
  pieces: number;
  /** Weight sold on this line; for ITEM mode equals the item's net weight. */
  netMg: number;
  grossMg: number;
  lessMg?: number;
  purityId: number;
  wastageBp: number;
  making: { mode: MakingMode; ratePaisa: number };
  stones: { stoneTypeId: number; count: number; totalCaratC: number; ratePaisaPerCarat: number }[];
  hallmarkChargePaisa: number;
  discountPaisa: number;
  description: string;
}

export interface OldGoldLineInput {
  purityId: number;
  netMg: number;
  grossMg: number;
  touchBp: number;
  description: string;
}

export interface PaymentInput {
  method: PaymentMethod;
  amountPaisa: number;
  bankRef?: string;
}

export interface FinalizeInvoiceInput {
  documentId: number;
  customerId?: number | null;
  saleLines: SaleLineInput[];
  oldGoldLines: OldGoldLineInput[];
  payments: PaymentInput[];
  tax: TaxConfig;
  roundTo: 1 | 100;
  discountApprovedBy?: number | null;
  scrapLocationId: number;
  /** Signed whole-sale adjustment applied AFTER line totals: negative = discount,
   * positive = surcharge. The counter uses it to set a custom final amount. */
  saleAdjustmentPaisa?: number;
  /** Caller's role; the discount ceiling is enforced against it. */
  role: Role;
}

export interface FinalizeResult {
  documentId: number;
  docNumber: string;
  grandTotalPaisa: number;
}

/** Locked rate for a purity on this draft. Throws if the purity wasn't locked. */
function lockedRate(db: DB, documentId: number, purityId: number): RateSnapshot {
  const row = db
    .prepare(
      `SELECT l.metal_rate_id, r.rate_paisa_per_gram
       FROM document_rate_locks l JOIN metal_rates r ON r.id = l.metal_rate_id
       WHERE l.document_id=? AND l.purity_id=?`,
    )
    .get(documentId, purityId) as
    | { metal_rate_id: number; rate_paisa_per_gram: number }
    | undefined;
  if (!row) throw new Error(`no rate lock for purity ${purityId} on document ${documentId}`);
  return { purityId, metalRateId: row.metal_rate_id, ratePaisaPerGram: row.rate_paisa_per_gram };
}

/** Atomically issue and format the next document number for a fiscal year. */
function issueDocNumber(db: DB, docType: string, fiscalYear: number): string {
  const seq = db
    .prepare(
      `UPDATE doc_sequences SET next_no = next_no + 1
       WHERE doc_type=? AND fiscal_year=? RETURNING next_no - 1 AS n, prefix`,
    )
    .get(docType, fiscalYear) as { n: number; prefix: string } | undefined;
  if (!seq) throw new Error(`no sequence for ${docType} ${fiscalYear}`);
  return `${seq.prefix}-${fiscalYear}-${String(seq.n).padStart(4, '0')}`;
}

/** POS checkout: builds a draft, snapshots the latest rate for every purity the
 * cart touches into document_rate_locks, and finalizes — all in one call so the
 * counter UI does a single round-trip. dateISO is passed in (services take no
 * clock) and its year drives the invoice number's fiscal year. */
export interface CheckoutInput {
  dateISO: string;
  /** The caller's role, taken from the main-process session (never the renderer).
   * Drives the discount-authority ceiling. */
  role: Role;
  customerId?: number | null;
  saleLines: SaleLineInput[];
  oldGoldLines: OldGoldLineInput[];
  payments: PaymentInput[];
  discountApprovedBy?: number | null;
  /** Signed whole-sale adjustment (negative = discount, positive = surcharge). */
  saleAdjustmentPaisa?: number;
}

/** Whole-percent discount ceiling for a role, from app_settings. OWNER and
 * MANAGER share the higher bound; a SALESMAN gets the tighter one. */
function discountCeilingPct(db: DB, role: Role): number {
  const key = role === 'SALESMAN' ? 'max_discount_pct_salesman' : 'max_discount_pct_manager';
  const raw = (db.prepare('SELECT value FROM app_settings WHERE key=?').get(key) as
    | { value: string }
    | undefined)?.value;
  const pct = Number(raw);
  // A missing/garbled setting must not silently open the till: fall back to the
  // conservative default rather than to "no limit".
  if (!Number.isFinite(pct) || pct < 0) return role === 'SALESMAN' ? 5 : 20;
  return pct;
}

/**
 * Reject a sale whose downward adjustment exceeds the caller's authority.
 *
 * `adjustment` is signed: negative discounts the bill, positive surcharges it.
 * Only discounts are capped — charging MORE than computed is never a leak. The
 * cap is a percentage of the computed total, so it scales with the bill instead
 * of being a flat rupee figure that is meaningless across a Rs 5,000 chain and
 * a Rs 5,00,000 set.
 */
export function assertDiscountAllowed(
  db: DB,
  role: Role,
  computedTotalPaisa: number,
  adjustmentPaisa: number,
): void {
  if (adjustmentPaisa >= 0) return; // surcharge or exact — always fine
  const discount = -adjustmentPaisa;

  // A discount on a zero/negative bill (pure old-gold exchange) has no
  // percentage to measure against; refuse it outright rather than divide by zero.
  if (computedTotalPaisa <= 0) {
    throw new Error('cannot discount a sale with no positive total');
  }
  if (discount > computedTotalPaisa) {
    throw new Error('discount cannot exceed the sale total');
  }

  const pct = discountCeilingPct(db, role);
  // Compare in integer paisa (discount/total vs pct/100) to avoid float drift.
  const allowedPaisa = Math.floor((computedTotalPaisa * pct) / 100);
  if (discount > allowedPaisa) {
    const asPct = ((discount / computedTotalPaisa) * 100).toFixed(1);
    throw new Error(
      `discount of ${asPct}% exceeds the ${pct}% limit for ${role}; ` +
        `a manager or owner must approve this sale`,
    );
  }
}

function readTaxConfig(db: DB): TaxConfig {
  const get = (k: string, d: string) =>
    (db.prepare('SELECT value FROM app_settings WHERE key=?').get(k) as { value: string } | undefined)
      ?.value ?? d;
  return {
    rateBp: Number(get('tax_rate_bp', '0')),
    base: get('tax_base', 'TOTAL') as TaxConfig['base'],
  };
}

function readRoundTo(db: DB): 1 | 100 {
  const v = (db.prepare(`SELECT value FROM app_settings WHERE key='invoice_round_to'`).get() as
    | { value: string }
    | undefined)?.value;
  return v === '1' ? 1 : 100;
}

/** Read a finalized invoice with its lines and payments, for the receipt view. */
export function getInvoice(db: DB, id: number) {
  const doc = db
    .prepare(
      `SELECT d.*, p.name AS customer_name FROM documents d
       LEFT JOIN parties p ON p.id = d.party_id WHERE d.id=?`,
    )
    .get(id) as
    | (Record<string, number | string | null> & { customer_name: string | null })
    | undefined;
  if (!doc) throw new Error(`invoice ${id} not found`);

  const lines = db
    .prepare(
      `SELECT line_kind, description, pieces, net_mg, rate_paisa_per_gram, metal_value_paisa,
              making_value_paisa, wastage_value_paisa, stone_value_paisa, hallmark_charge_paisa,
              tax_paisa, line_total_paisa
       FROM document_lines WHERE document_id=? ORDER BY line_no`,
    )
    .all(id) as Array<Record<string, number | string>>;

  const payments = db
    .prepare(`SELECT method, amount_paisa FROM payments WHERE document_id=? ORDER BY id`)
    .all(id) as Array<{ method: string; amount_paisa: number }>;

  return {
    id: Number(doc.id),
    docNumber: (doc.doc_number as string | null) ?? null,
    docDate: doc.doc_date as string,
    customerName: doc.customer_name,
    lines: lines.map((l) => ({
      lineKind: l.line_kind as 'ITEM' | 'LOT_WEIGHT' | 'OLD_GOLD_EXCHANGE' | 'RETURN',
      description: l.description as string,
      pieces: l.pieces as number,
      netMg: l.net_mg as number,
      ratePaisaPerGram: l.rate_paisa_per_gram as number,
      metalValuePaisa: l.metal_value_paisa as number,
      makingValuePaisa: l.making_value_paisa as number,
      wastageValuePaisa: l.wastage_value_paisa as number,
      stoneValuePaisa: l.stone_value_paisa as number,
      hallmarkChargePaisa: l.hallmark_charge_paisa as number,
      taxPaisa: l.tax_paisa as number,
      lineTotalPaisa: l.line_total_paisa as number,
    })),
    payments: payments.map((p) => ({ method: p.method, amountPaisa: p.amount_paisa })),
    metalValuePaisa: doc.metal_value_paisa as number,
    makingValuePaisa: doc.making_value_paisa as number,
    wastageValuePaisa: doc.wastage_value_paisa as number,
    stoneValuePaisa: doc.stone_value_paisa as number,
    hallmarkValuePaisa: doc.hallmark_value_paisa as number,
    exchangeValuePaisa: doc.exchange_value_paisa as number,
    discountPaisa: doc.discount_paisa as number,
    taxPaisa: doc.tax_paisa as number,
    roundingPaisa: doc.rounding_paisa as number,
    saleAdjustmentPaisa: (doc.sale_adjustment_paisa as number) ?? 0,
    grandTotalPaisa: doc.grand_total_paisa as number,
  };
}

export function checkout(db: DB, userId: number, input: CheckoutInput): FinalizeResult {
  return withAudit(db, userId, () => {
    // 1. Open the draft header.
    const rootLocation = (
      db.prepare(`SELECT id FROM locations ORDER BY id LIMIT 1`).get() as { id: number }
    ).id;
    const docInfo = db
      .prepare(
        `INSERT INTO documents (doc_type, status, party_id, doc_date, created_by)
         VALUES ('SALE_INVOICE','DRAFT',?,?,?)`,
      )
      .run(input.customerId ?? null, input.dateISO, userId);
    const documentId = Number(docInfo.lastInsertRowid);

    // 2. Lock the latest rate for every purity the cart touches.
    const purityIds = new Set<number>();
    input.saleLines.forEach((l) => purityIds.add(l.purityId));
    input.oldGoldLines.forEach((l) => purityIds.add(l.purityId));
    const latestRateStmt = db.prepare(
      `SELECT id FROM metal_rates WHERE purity_id=? ORDER BY id DESC LIMIT 1`,
    );
    const lockStmt = db.prepare(
      `INSERT INTO document_rate_locks (document_id, purity_id, metal_rate_id) VALUES (?,?,?)`,
    );
    for (const purityId of purityIds) {
      const rate = latestRateStmt.get(purityId) as { id: number } | undefined;
      if (!rate) throw new Error(`no rate set for purity ${purityId}; enter today's rate first`);
      lockStmt.run(documentId, purityId, rate.id);
    }

    // 3. Finalize using the shared orchestrator (it opens its own audit scope,
    // which nests fine — better-sqlite3 transactions are single-connection).
    return finalizeInvoice(db, userId, {
      documentId,
      customerId: input.customerId ?? null,
      saleLines: input.saleLines,
      oldGoldLines: input.oldGoldLines,
      payments: input.payments,
      tax: readTaxConfig(db),
      roundTo: readRoundTo(db),
      discountApprovedBy: input.discountApprovedBy ?? null,
      scrapLocationId: rootLocation,
      saleAdjustmentPaisa: input.saleAdjustmentPaisa ?? 0,
      role: input.role,
    });
  });
}

export function finalizeInvoice(
  db: DB,
  userId: number,
  input: FinalizeInvoiceInput,
): FinalizeResult {
  return withAudit(db, userId, (audit) => {
    const doc = db
      .prepare('SELECT id, status, doc_type, doc_date FROM documents WHERE id=?')
      .get(input.documentId) as
      | { id: number; status: string; doc_type: string; doc_date: string }
      | undefined;
    if (!doc) throw new Error(`document ${input.documentId} not found`);
    if (doc.status !== 'DRAFT') throw new Error('only DRAFT documents can be finalized');

    const fiscalYear = Number(doc.doc_date.slice(0, 4));
    const docNumber = issueDocNumber(db, doc.doc_type, fiscalYear);

    const breakdowns: LineBreakdown[] = [];
    let lineNo = 0;

    const insertLine = db.prepare(
      `INSERT INTO document_lines
        (document_id, line_no, line_kind, item_id, description, pieces, gross_mg, less_mg, net_mg,
         touch_bp, purity_id, metal_rate_id, rate_paisa_per_gram, metal_value_paisa,
         making_mode, making_rate_paisa, making_value_paisa, wastage_bp, wastage_value_paisa,
         stone_value_paisa, hallmark_charge_paisa, discount_paisa, tax_bp, taxable_base_paisa,
         tax_paisa, line_total_paisa)
       VALUES
        (@document_id, @line_no, @line_kind, @item_id, @description, @pieces, @gross_mg, @less_mg, @net_mg,
         @touch_bp, @purity_id, @metal_rate_id, @rate_paisa_per_gram, @metal_value_paisa,
         @making_mode, @making_rate_paisa, @making_value_paisa, @wastage_bp, @wastage_value_paisa,
         @stone_value_paisa, @hallmark_charge_paisa, @discount_paisa, @tax_bp, @taxable_base_paisa,
         @tax_paisa, @line_total_paisa)
       RETURNING id`,
    );
    const insertLineStone = db.prepare(
      `INSERT INTO document_line_stones (line_id, stone_type_id, stone_count, total_carat_c, rate_paisa_per_carat, value_paisa)
       VALUES (?,?,?,?,?,?)`,
    );

    // ---- sale lines ----
    for (const l of input.saleLines) {
      const rate = lockedRate(db, input.documentId, l.purityId);
      const b = priceSaleLine(
        {
          netMg: l.netMg,
          wastageBp: l.wastageBp,
          making: l.making,
          stones: l.stones.map((s) => ({
            totalCaratC: s.totalCaratC,
            ratePaisaPerCarat: s.ratePaisaPerCarat,
          })),
          hallmarkChargePaisa: l.hallmarkChargePaisa,
        },
        rate,
        { paisa: l.discountPaisa },
        input.tax,
      );
      breakdowns.push(b);

      const tracking = db.prepare('SELECT tracking_mode FROM items WHERE id=?').get(l.itemId) as
        | { tracking_mode: string }
        | undefined;
      const lineKind = tracking?.tracking_mode === 'LOT' ? 'LOT_WEIGHT' : 'ITEM';

      const lineRow = insertLine.get({
        document_id: input.documentId,
        line_no: ++lineNo,
        line_kind: lineKind,
        item_id: l.itemId,
        description: l.description,
        pieces: l.pieces,
        gross_mg: l.grossMg,
        less_mg: l.lessMg ?? l.grossMg - l.netMg,
        net_mg: l.netMg,
        touch_bp: null,
        purity_id: l.purityId,
        metal_rate_id: rate.metalRateId,
        rate_paisa_per_gram: rate.ratePaisaPerGram,
        metal_value_paisa: b.metalValuePaisa,
        making_mode: l.making.mode,
        making_rate_paisa: l.making.ratePaisa,
        making_value_paisa: b.makingValuePaisa,
        wastage_bp: l.wastageBp,
        wastage_value_paisa: b.wastageValuePaisa,
        stone_value_paisa: b.stoneValuePaisa,
        hallmark_charge_paisa: b.hallmarkChargePaisa,
        discount_paisa: b.discountPaisa,
        tax_bp: input.tax.rateBp,
        taxable_base_paisa: b.taxableBasePaisa,
        tax_paisa: b.taxPaisa,
        line_total_paisa: b.lineTotalPaisa,
      }) as { id: number };

      for (const s of l.stones) {
        insertLineStone.run(
          lineRow.id,
          s.stoneTypeId,
          s.count,
          s.totalCaratC,
          s.ratePaisaPerCarat,
          Math.round((s.totalCaratC * s.ratePaisaPerCarat) / 100),
        );
      }

      // Post stock out. ITEM mode moves exactly one piece; LOT moves the weight.
      insertMovement(
        db,
        userId,
        {
          movementType: 'SALE_OUT',
          itemId: l.itemId,
          locationId: getItemLocation(db, l.itemId),
          piecesDelta: lineKind === 'ITEM' ? -1 : -l.pieces,
          grossMgDelta: -l.grossMg,
          netMgDelta: -l.netMg,
          documentId: input.documentId,
          documentLineId: lineRow.id,
        },
        audit,
      );
      if (lineKind === 'ITEM') {
        db.prepare("UPDATE items SET status='SOLD' WHERE id=?").run(l.itemId);
      }
    }

    // ---- old-gold exchange lines ----
    for (const g of input.oldGoldLines) {
      const rate = lockedRate(db, input.documentId, g.purityId);
      const b = priceOldGoldLine(g.netMg, g.touchBp, rate);
      breakdowns.push(b);

      const scrapItemId = ensureScrapItem(db, userId, g.purityId, input.scrapLocationId);
      const lineRow = insertLine.get({
        document_id: input.documentId,
        line_no: ++lineNo,
        line_kind: 'OLD_GOLD_EXCHANGE',
        item_id: scrapItemId,
        description: g.description,
        pieces: 1,
        gross_mg: g.grossMg,
        less_mg: g.grossMg - g.netMg,
        net_mg: g.netMg,
        touch_bp: g.touchBp,
        purity_id: g.purityId,
        metal_rate_id: rate.metalRateId,
        rate_paisa_per_gram: rate.ratePaisaPerGram,
        metal_value_paisa: b.metalValuePaisa,
        making_mode: null,
        making_rate_paisa: 0,
        making_value_paisa: 0,
        wastage_bp: 0,
        wastage_value_paisa: 0,
        stone_value_paisa: 0,
        hallmark_charge_paisa: 0,
        discount_paisa: 0,
        tax_bp: 0,
        taxable_base_paisa: 0,
        tax_paisa: 0,
        line_total_paisa: b.lineTotalPaisa,
      }) as { id: number };

      // Scrap enters stock through the ledger like everything else.
      insertMovement(
        db,
        userId,
        {
          movementType: 'EXCHANGE_IN',
          itemId: scrapItemId,
          locationId: input.scrapLocationId,
          piecesDelta: 1,
          grossMgDelta: g.grossMg,
          netMgDelta: g.netMg,
          documentId: input.documentId,
          documentLineId: lineRow.id,
        },
        audit,
      );
    }

    // ---- totals ----
    const totals = totalDocument(breakdowns, input.roundTo);
    const adjustment = input.saleAdjustmentPaisa ?? 0;

    // Discount authority. Checked BEFORE any payment is written, against the
    // engine's own computed total — never against a figure the renderer sent.
    assertDiscountAllowed(db, input.role, totals.grandTotalPaisa, adjustment);

    // ---- payments ----
    let paid = 0;
    const insertPayment = db.prepare(
      `INSERT INTO payments (document_id, method, amount_paisa, bank_ref, received_by)
       VALUES (?,?,?,?,?)`,
    );
    for (const p of input.payments) {
      insertPayment.run(input.documentId, p.method, p.amountPaisa, p.bankRef ?? null, userId);
      paid += p.amountPaisa;
    }

    // The amount actually charged is what was paid, PROVIDED it's within the
    // invoice's rounding step of the computed total (plus any deliberate
    // adjustment). This makes the sale robust to tiny client/server rounding
    // differences instead of rejecting the sale over a few paisa — the shopkeeper
    // charges a clean figure and the small delta is recorded as rounding.
    const targetTotal = totals.grandTotalPaisa + adjustment;
    const tolerance = input.roundTo; // e.g. 100 paisa = up to Rs 1 either way
    if (Math.abs(paid - targetTotal) > tolerance) {
      throw new Error(`payments (${paid}) do not cover grand total (${targetTotal})`);
    }
    if (paid < 0) {
      throw new Error('sale total cannot be negative');
    }
    // Charge exactly what was paid; fold the (tiny) difference into the adjustment
    // so the header's totals reconcile with the payment.
    const chargedTotal = paid;
    const effectiveAdjustment = chargedTotal - totals.grandTotalPaisa;
    // `paid` may differ from the requested adjustment by up to one rounding step,
    // so the ACTUAL discount is re-checked here. Without this, the tolerance
    // window would be a hole straight through the ceiling above.
    assertDiscountAllowed(db, input.role, totals.grandTotalPaisa, effectiveAdjustment);

    // ---- freeze header + finalize ----
    db.prepare(
      `UPDATE documents SET
         doc_number=@doc_number, party_id=@party_id, status='FINAL',
         metal_value_paisa=@metal, making_value_paisa=@making, wastage_value_paisa=@wastage,
         stone_value_paisa=@stone, hallmark_value_paisa=@hallmark, exchange_value_paisa=@exchange,
         discount_paisa=@discount, tax_paisa=@tax, rounding_paisa=@rounding,
         sale_adjustment_paisa=@adjustment, grand_total_paisa=@grand, discount_approved_by=@approver,
         finalized_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'), finalized_by=@user
       WHERE id=@id`,
    ).run({
      id: input.documentId,
      doc_number: docNumber,
      party_id: input.customerId ?? null,
      metal: sumWhere(breakdowns, (b) => (b.metalValuePaisa > 0 ? b.metalValuePaisa : 0)),
      making: sum(breakdowns, (b) => b.makingValuePaisa),
      wastage: sum(breakdowns, (b) => b.wastageValuePaisa),
      stone: sum(breakdowns, (b) => b.stoneValuePaisa),
      hallmark: sum(breakdowns, (b) => b.hallmarkChargePaisa),
      exchange: sumWhere(breakdowns, (b) => (b.metalValuePaisa < 0 ? b.metalValuePaisa : 0)),
      discount: totals.discountPaisa,
      tax: totals.taxPaisa,
      rounding: totals.roundingPaisa,
      adjustment: effectiveAdjustment,
      grand: chargedTotal,
      approver: input.discountApprovedBy ?? null,
      user: userId,
    });

    audit.record({
      table: 'documents',
      rowPk: input.documentId,
      action: 'FINALIZE',
      changes: { docNumber, grandTotalPaisa: chargedTotal, saleAdjustmentPaisa: effectiveAdjustment },
    });

    return {
      documentId: input.documentId,
      docNumber,
      grandTotalPaisa: chargedTotal,
    };
  });
}

function sum(bs: LineBreakdown[], f: (b: LineBreakdown) => number): number {
  return bs.reduce((acc, b) => acc + f(b), 0);
}
function sumWhere(bs: LineBreakdown[], f: (b: LineBreakdown) => number): number {
  return bs.reduce((acc, b) => acc + f(b), 0);
}

function getItemLocation(db: DB, itemId: number): number {
  const row = db.prepare('SELECT location_id FROM items WHERE id=?').get(itemId) as
    | { location_id: number }
    | undefined;
  if (!row) throw new Error(`item ${itemId} not found`);
  return row.location_id;
}

/**
 * A single scrap LOT item per purity accumulates all old-gold intake. Created
 * lazily the first time old gold of that purity is taken in.
 */
function ensureScrapItem(db: DB, userId: number, purityId: number, locationId: number): number {
  const tag = `SCRAP-${purityId}`;
  const existing = db.prepare('SELECT id FROM items WHERE tag_number=?').get(tag) as
    | { id: number }
    | undefined;
  if (existing) return existing.id;

  const meta = db
    .prepare(
      `SELECT p.metal_id,
              (SELECT id FROM product_types ORDER BY sort_order LIMIT 1) pt,
              (SELECT id FROM stone_types WHERE name='Plain') st,
              (SELECT id FROM making_types ORDER BY sort_order LIMIT 1) mt
       FROM purities p WHERE p.id=?`,
    )
    .get(purityId) as { metal_id: number; pt: number; st: number; mt: number };

  const info = db
    .prepare(
      `INSERT INTO items
        (tracking_mode, tag_number, name, product_type_id, metal_id, purity_id, stone_type_id,
         making_type_id, origin_kind, gross_mg, less_mg, net_mg, status, location_id, created_by)
       VALUES ('LOT', @tag, @name, @pt, @metal, @purity, @st, @mt, 'OLD_GOLD', 0, 0, 0, 'IN_STOCK', @loc, @user)`,
    )
    .run({
      tag,
      name: `Old Gold Scrap (purity ${purityId})`,
      pt: meta.pt,
      metal: meta.metal_id,
      purity: purityId,
      st: meta.st,
      mt: meta.mt,
      loc: locationId,
      user: userId,
    });
  return Number(info.lastInsertRowid);
}
