/**
 * Reports that tell the owner something they could not have worked out.
 *
 * The rest of the app records what the shopkeeper already knows — they were
 * there when the sale happened. These two queries are the ones a notebook
 * cannot answer:
 *
 *  - Profit split into what was EARNED (making, wastage, stones) versus what
 *    the METAL did between intake and sale. A jeweller cannot do that in their
 *    head, because it needs the rate stamped on the invoice compared against
 *    the rate the piece came in at — both of which this database keeps.
 *  - Which stock is dead, and how much cash is asleep in it.
 *
 * Everything is integer paisa, read straight from finalised documents. Nothing
 * here writes, so a report can never disturb the books.
 */
import type { DB } from '../db/connection.js';
import { withAudit } from '../db/audit.js';

// ---- profit ---------------------------------------------------------------

export interface ProfitRow {
  invoiceId: number;
  docNumber: string | null;
  docDate: string;
  partyName: string | null;
  /** What the customer paid, after discount, tax and rounding. */
  grandTotalPaisa: number;
  /** Making + wastage + stones + hallmark: the shop's own labour and margin. */
  earnedPaisa: number;
  /**
   * Metal sold at today's rate minus the same metal valued at what it cost to
   * bring in. Positive when gold rose while the piece sat in the case.
   * Null where the piece has no recorded intake rate — never guessed.
   */
  metalGainPaisa: number | null;
  /** earned + metalGain - discount. Null when metal gain is unknown. */
  totalProfitPaisa: number | null;
  /** True when at least one line lacked an intake rate, so profit is partial. */
  isPartial: boolean;
}

export interface ProfitSummary {
  fromDate: string;
  toDate: string;
  invoiceCount: number;
  revenuePaisa: number;
  earnedPaisa: number;
  metalGainPaisa: number;
  discountPaisa: number;
  totalProfitPaisa: number;
  /** Invoices whose metal gain could not be computed for want of a cost basis. */
  invoicesMissingCost: number;
  rows: ProfitRow[];
}

/**
 * Profit for finalised sale invoices in a date range (inclusive, YYYY-MM-DD).
 *
 * Old-gold exchange lines are excluded from the earned figure: buying scrap is
 * not a margin event, and its value already sits in the invoice total as a
 * negative line. Return documents reduce the range's revenue through their own
 * negative totals, so no separate subtraction is needed.
 */
export function profitReport(db: DB, fromDate: string, toDate: string): ProfitSummary {
  const rows = db
    .prepare(
      `SELECT d.id, d.doc_number, d.doc_date, d.grand_total_paisa, d.discount_paisa,
              p.name AS party_name,
              COALESCE(SUM(
                CASE WHEN l.line_kind = 'OLD_GOLD_EXCHANGE' THEN 0
                     ELSE l.making_value_paisa + l.wastage_value_paisa
                          + l.stone_value_paisa + l.hallmark_charge_paisa END
              ), 0) AS earned_paisa,
              -- Metal gain: (sale rate - intake rate) x net grams, per line.
              -- NULL intake rate poisons the SUM for that line, which is what
              -- we want: it surfaces as a partial rather than a wrong number.
              SUM(
                CASE WHEN l.line_kind = 'OLD_GOLD_EXCHANGE' THEN 0
                     ELSE ((l.rate_paisa_per_gram - ic.intake_rate_paisa_per_gram)
                           * l.net_mg) / 1000 END
              ) AS metal_gain_paisa,
              SUM(
                CASE WHEN l.line_kind <> 'OLD_GOLD_EXCHANGE'
                          AND ic.intake_rate_paisa_per_gram IS NULL
                     THEN 1 ELSE 0 END
              ) AS missing_cost_lines
       FROM documents d
       JOIN document_lines l ON l.document_id = d.id
       LEFT JOIN item_costs ic ON ic.item_id = l.item_id
       LEFT JOIN parties p ON p.id = d.party_id
       WHERE d.doc_type = 'SALE_INVOICE'
         AND d.status = 'FINAL'
         AND date(d.doc_date) BETWEEN date(?) AND date(?)
       GROUP BY d.id
       ORDER BY d.doc_date DESC, d.id DESC`,
    )
    .all(fromDate, toDate) as Array<{
    id: number;
    doc_number: string | null;
    doc_date: string;
    grand_total_paisa: number;
    discount_paisa: number;
    party_name: string | null;
    earned_paisa: number;
    metal_gain_paisa: number | null;
    missing_cost_lines: number;
  }>;

  const out: ProfitRow[] = rows.map((r) => {
    const isPartial = r.missing_cost_lines > 0;
    const metalGain = isPartial ? null : Math.round(r.metal_gain_paisa ?? 0);
    return {
      invoiceId: r.id,
      docNumber: r.doc_number,
      docDate: r.doc_date,
      partyName: r.party_name,
      grandTotalPaisa: r.grand_total_paisa,
      earnedPaisa: r.earned_paisa,
      metalGainPaisa: metalGain,
      totalProfitPaisa: metalGain == null ? null : r.earned_paisa + metalGain - r.discount_paisa,
      isPartial,
    };
  });

  const sum = (pick: (r: ProfitRow) => number | null) =>
    out.reduce((a, r) => a + (pick(r) ?? 0), 0);

  const earned = sum((r) => r.earnedPaisa);
  const discount = rows.reduce((a, r) => a + r.discount_paisa, 0);
  const metalGain = sum((r) => r.metalGainPaisa);

  return {
    fromDate,
    toDate,
    invoiceCount: out.length,
    revenuePaisa: sum((r) => r.grandTotalPaisa),
    earnedPaisa: earned,
    metalGainPaisa: metalGain,
    discountPaisa: discount,
    /*
     * The headline is everything that IS known, not everything or nothing.
     *
     * Summing only the fully-costed rows reported Rs 0 for a shop that had
     * plainly earned lakhs in making charges, because one unknown component
     * zeroed the whole figure. Making, wastage and stones never depend on a
     * cost basis, so they are always real profit; the metal's movement is added
     * only where it is known, and `invoicesMissingCost` tells the reader how
     * much is still outstanding.
     */
    totalProfitPaisa: earned + metalGain - discount,
    invoicesMissingCost: out.filter((r) => r.isPartial).length,
    rows: out,
  };
}

// ---- dead stock -----------------------------------------------------------

export interface DeadStockRow {
  itemId: number;
  name: string;
  tagNumber: string | null;
  productType: string;
  purityLabel: string;
  pieces: number;
  netMg: number;
  /** Days since the piece entered stock, or since it last sold — whichever is later. */
  daysResting: number;
  /** Metal value at today's rate, plus making. What is asleep in this piece. */
  lockedValuePaisa: number;
  lastMovementAt: string;
}

export interface DeadStockSummary {
  thresholdDays: number;
  itemCount: number;
  totalLockedPaisa: number;
  rows: DeadStockRow[];
}

/**
 * Stock that has not moved in `thresholdDays`, worth the most first.
 *
 * "Resting" counts from the item's most recent movement of any kind, so a piece
 * that came back from a karigar last week is correctly not dead. Value is
 * computed at today's rate — the question the owner is asking is "how much of
 * my money is asleep right now", not what it was worth on intake.
 */
export function deadStockReport(db: DB, thresholdDays = 180, limit = 200): DeadStockSummary {
  const rows = db
    .prepare(
      `SELECT i.id, i.name, i.tag_number, i.net_mg,
              pt.name AS product_type, pu.label AS purity_label,
              b.pieces, b.net_mg AS bal_net_mg,
              MAX(sm.created_at) AS last_movement,
              CAST(julianday('now') - julianday(MAX(sm.created_at)) AS INTEGER) AS days_resting,
              lr.rate_paisa_per_gram
       FROM items i
       JOIN item_balances b ON b.item_id = i.id
       JOIN product_types pt ON pt.id = i.product_type_id
       JOIN purities pu ON pu.id = i.purity_id
       JOIN stock_movements sm ON sm.item_id = i.id
       LEFT JOIN (
         SELECT purity_id, rate_paisa_per_gram
         FROM metal_rates
         WHERE id IN (SELECT MAX(id) FROM metal_rates GROUP BY purity_id)
       ) lr ON lr.purity_id = i.purity_id
       WHERE b.pieces > 0 OR b.net_mg > 0
       GROUP BY i.id
       HAVING days_resting >= ?
       ORDER BY (COALESCE(lr.rate_paisa_per_gram, 0) * b.net_mg) / 1000 DESC
       LIMIT ?`,
    )
    .all(thresholdDays, limit) as Array<{
    id: number;
    name: string;
    tag_number: string | null;
    product_type: string;
    purity_label: string;
    pieces: number;
    bal_net_mg: number;
    last_movement: string;
    days_resting: number;
    rate_paisa_per_gram: number | null;
  }>;

  const out: DeadStockRow[] = rows.map((r) => ({
    itemId: r.id,
    name: r.name,
    tagNumber: r.tag_number,
    productType: r.product_type,
    purityLabel: r.purity_label,
    pieces: r.pieces,
    netMg: r.bal_net_mg,
    daysResting: r.days_resting,
    lockedValuePaisa: Math.round(((r.rate_paisa_per_gram ?? 0) * r.bal_net_mg) / 1000),
    lastMovementAt: r.last_movement,
  }));

  return {
    thresholdDays,
    itemCount: out.length,
    totalLockedPaisa: out.reduce((a, r) => a + r.lockedValuePaisa, 0),
    rows: out,
  };
}

// ---- missing cost basis -----------------------------------------------------

export interface MissingCostRow {
  itemId: number;
  name: string;
  tagNumber: string | null;
  purityId: number;
  purityLabel: string;
  netMg: number;
  /** True once the piece has been sold — its cost can no longer be observed,
   * but recording it still completes the profit figure for that past sale. */
  isSold: boolean;
}

/**
 * Pieces with no purchase rate recorded.
 *
 * This is the gap that makes the profit report say "gold movement unknown".
 * Every shop that imported a catalogue, or added stock before this field
 * existed, starts here — so the report needs to lead the owner to the fix
 * rather than just naming the problem.
 */
export function itemsMissingCost(db: DB, limit = 500): MissingCostRow[] {
  const rows = db
    .prepare(
      `SELECT i.id, i.name, i.tag_number, i.net_mg, i.status,
              i.purity_id, pu.label AS purity_label
       FROM items i
       JOIN purities pu ON pu.id = i.purity_id
       LEFT JOIN item_costs ic ON ic.item_id = i.id
       WHERE ic.intake_rate_paisa_per_gram IS NULL
       ORDER BY i.id DESC
       LIMIT ?`,
    )
    .all(limit) as Array<{
    id: number;
    name: string;
    tag_number: string | null;
    net_mg: number;
    status: string;
    purity_id: number;
    purity_label: string;
  }>;

  return rows.map((r) => ({
    itemId: r.id,
    name: r.name,
    tagNumber: r.tag_number,
    purityId: r.purity_id,
    purityLabel: r.purity_label,
    netMg: r.net_mg,
    isSold: r.status === 'SOLD',
  }));
}

/**
 * Record a purchase rate against many pieces at once.
 *
 * Backfilling a catalogue one form at a time is not something a shop with 400
 * pieces will ever finish, so the profit report offers this: pick a purity,
 * give the rate that was being paid around then, and every piece of that purity
 * still missing a cost gets it.
 *
 * It is an estimate and the caller says so on screen. That is a deliberate
 * trade: an approximate cost basis makes the metal-movement figure roughly
 * right, where no basis at all leaves it blank forever. Only pieces with NO
 * rate are touched, so a figure someone entered by hand is never overwritten.
 */
export function backfillIntakeRate(
  db: DB,
  userId: number,
  purityId: number,
  ratePaisaPerGram: number,
): number {
  if (ratePaisaPerGram <= 0) {
    throw new Error('A purchase rate must be more than zero.');
  }
  return withAudit(db, userId, (ctx) => {
    const run = db.transaction(() => {
      const info = db
        .prepare(
          `INSERT INTO item_costs (item_id, intake_rate_paisa_per_gram, updated_by)
           SELECT i.id, @rate, @user
           FROM items i
           LEFT JOIN item_costs ic ON ic.item_id = i.id
           WHERE i.purity_id = @purity AND ic.item_id IS NULL
           ON CONFLICT(item_id) DO NOTHING`,
        )
        .run({ rate: ratePaisaPerGram, user: userId, purity: purityId });

      // A piece can have an item_costs row with labour but a null rate, which
      // the INSERT above skips. Fill those in the same pass.
      const updated = db
        .prepare(
          `UPDATE item_costs
           SET intake_rate_paisa_per_gram = @rate,
               updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
               updated_by = @user
           WHERE intake_rate_paisa_per_gram IS NULL
             AND item_id IN (SELECT id FROM items WHERE purity_id = @purity)`,
        )
        .run({ rate: ratePaisaPerGram, user: userId, purity: purityId });

      return Number(info.changes) + Number(updated.changes);
    });

    const changed = run();
    ctx.record({
      table: 'item_costs',
      rowPk: 0,
      action: 'UPDATE',
      changes: { backfillPurityId: purityId, ratePaisaPerGram, pieces: changed },
    });
    return changed;
  });
}
