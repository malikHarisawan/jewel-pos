import { describe, it, expect, beforeEach } from 'vitest';
import { openDatabase, type DB } from '../src/main/db/connection.js';
import { createItem } from '../src/main/services/itemService.js';
import { enterRate } from '../src/main/services/rateService.js';
import { checkout } from '../src/main/services/invoiceService.js';
import {
  profitReport,
  deadStockReport,
  itemsMissingCost,
  backfillIntakeRate,
} from '../src/main/services/reportService.js';
import { CreateItemInput } from '../src/shared/contracts/index.js';
import type { z } from 'zod';

let db: DB;

function purity(d: DB, label: string) {
  return (d.prepare('SELECT id FROM purities WHERE label=?').get(label) as { id: number }).id;
}
function gold(d: DB) {
  return (d.prepare(`SELECT id FROM metals WHERE name='Gold'`).get() as { id: number }).id;
}

function makeRing(d: DB, tag: string, netMg: number, over: Partial<z.infer<typeof CreateItemInput>> = {}) {
  return createItem(
    d,
    1,
    'OWNER',
    CreateItemInput.parse({
      trackingMode: 'ITEM',
      name: 'Ring',
      tagNumber: tag,
      productTypeId: 1,
      metalId: gold(d),
      purityId: purity(d, '22K / 916'),
      stoneTypeId: 1,
      makingTypeId: 1,
      originKind: 'IN_HOUSE',
      grossMg: netMg,
      netMg,
      makingMode: 'PER_GRAM',
      makingRatePaisa: 50_000,
      locationId: 1,
      openingPieces: 1,
      ...over,
    }),
  ).id;
}

/** Record what a piece cost to bring in, so metal gain has a basis. */
function setIntakeRate(d: DB, itemId: number, paisaPerGram: number) {
  d.prepare(
    `INSERT INTO item_costs (item_id, intake_rate_paisa_per_gram, updated_by)
     VALUES (?,?,1)
     ON CONFLICT(item_id) DO UPDATE SET intake_rate_paisa_per_gram = excluded.intake_rate_paisa_per_gram`,
  ).run(itemId, paisaPerGram);
}

/** Sell a whole ring at the current rate, no discount, no exchange. */
function sell(d: DB, itemId: number, netMg: number, dateISO = '2026-07-27T10:00:00.000Z') {
  const p22 = purity(d, '22K / 916');
  const metal = Math.round((netMg * 2_500_000) / 1000);
  const making = Math.round((netMg * 50_000) / 1000);
  const total = metal + making;
  return checkout(d, 1, {
    dateISO,
    role: 'OWNER',
    saleLines: [
      {
        itemId,
        pieces: 1,
        netMg,
        grossMg: netMg,
        purityId: p22,
        wastageBp: 0,
        making: { mode: 'PER_GRAM', ratePaisa: 50_000 },
        stones: [],
        hallmarkChargePaisa: 0,
        discountPaisa: 0,
        description: 'Gold Ring',
      },
    ],
    oldGoldLines: [],
    payments: [{ method: 'CASH', amountPaisa: total }],
  });
}

/**
 * A ring whose entire stock history sits `days` in the past.
 *
 * `stock_movements` is append-only even to a test, so the opening movement is
 * written directly with an explicit `created_at` rather than created through
 * the service and aged afterwards.
 */
function makeRingAged(d: DB, tag: string, netMg: number, days: number) {
  const id = makeRing(d, tag, netMg, { openingPieces: 0 });
  d.prepare(
    `INSERT INTO stock_movements
       (movement_type, item_id, location_id, pieces_delta, gross_mg_delta, net_mg_delta,
        created_by, created_at)
     VALUES ('OPENING', ?, 1, 1, ?, ?, 1, datetime('now', ?))`,
  ).run(id, netMg, netMg, `-${days} days`);
  return id;
}

beforeEach(() => {
  db = openDatabase({ filename: ':memory:' });
  db.prepare(
    `INSERT INTO users (id, username, display_name, pin_hash, role) VALUES (1,'owner','Owner','x','OWNER')`,
  ).run();
  // No tax, so profit arithmetic in these tests is readable.
  db.prepare(`UPDATE app_settings SET value='0' WHERE key='tax_rate_bp'`).run();
  enterRate(db, 1, {
    purityId: purity(db, '22K / 916'),
    enteredValuePaisa: 2_500_000,
    enteredBasis: 'PER_GRAM',
  });
});

describe('profitReport', () => {
  it('is empty and zeroed for a range with no sales', () => {
    const r = profitReport(db, '2026-07-01', '2026-07-31');
    expect(r.invoiceCount).toBe(0);
    expect(r.totalProfitPaisa).toBe(0);
    expect(r.rows).toEqual([]);
  });

  it('separates what the shop earned from what the metal did', () => {
    const ring = makeRing(db, 'R1', 20_000); // 20g
    // Bought in at Rs 24,000/g, selling at Rs 25,000/g -> Rs 1,000/g gain.
    setIntakeRate(db, ring, 2_400_000);
    sell(db, ring, 20_000);

    const r = profitReport(db, '2026-07-01', '2026-07-31');
    expect(r.invoiceCount).toBe(1);

    // Making: 20g x Rs 500/g = Rs 10,000 = 1,000,000 paisa.
    expect(r.earnedPaisa).toBe(1_000_000);
    // Metal gain: 20g x Rs 1,000/g = Rs 20,000 = 2,000,000 paisa.
    expect(r.metalGainPaisa).toBe(2_000_000);
    expect(r.totalProfitPaisa).toBe(3_000_000);
    expect(r.invoicesMissingCost).toBe(0);
  });

  it('reports a loss when the metal fell between intake and sale', () => {
    const ring = makeRing(db, 'R1', 20_000);
    // Bought high at Rs 26,000/g, selling at Rs 25,000/g.
    setIntakeRate(db, ring, 2_600_000);
    sell(db, ring, 20_000);

    const r = profitReport(db, '2026-07-01', '2026-07-31');
    expect(r.metalGainPaisa).toBe(-2_000_000);
    // Making still earned, so the net is making minus the metal loss.
    expect(r.totalProfitPaisa).toBe(1_000_000 - 2_000_000);
  });

  it('marks an invoice partial rather than inventing a cost basis', () => {
    const ring = makeRing(db, 'R1', 20_000);
    // No item_costs row at all.
    sell(db, ring, 20_000);

    const r = profitReport(db, '2026-07-01', '2026-07-31');
    expect(r.rows[0].isPartial).toBe(true);
    expect(r.rows[0].metalGainPaisa).toBeNull();
    expect(r.rows[0].totalProfitPaisa).toBeNull();
    expect(r.invoicesMissingCost).toBe(1);
    // A partial invoice contributes nothing to the metal-gain total, so that
    // figure is never silently wrong.
    expect(r.metalGainPaisa).toBe(0);
    // Earned is still known — making charges do not depend on a cost basis.
    expect(r.earnedPaisa).toBe(1_000_000);
  });

  it('reports the profit it does know rather than zero', () => {
    // A shop with no cost basis recorded anywhere still earned its making
    // charges. Reporting Rs 0 because one component is unknown reads as "you
    // made nothing", which is worse than incomplete — it is wrong.
    const ring = makeRing(db, 'R1', 20_000);
    sell(db, ring, 20_000);

    const r = profitReport(db, '2026-07-01', '2026-07-31');
    expect(r.invoicesMissingCost).toBe(1);
    expect(r.totalProfitPaisa).toBe(1_000_000);
  });

  it('adds known metal gain to known earnings across mixed invoices', () => {
    const costed = makeRing(db, 'R1', 20_000);
    const uncosted = makeRing(db, 'R2', 20_000);
    setIntakeRate(db, costed, 2_400_000);
    sell(db, costed, 20_000);
    sell(db, uncosted, 20_000);

    const r = profitReport(db, '2026-07-01', '2026-07-31');
    // Both bills earned making (2 x 1,000,000); only one has a known gain.
    expect(r.earnedPaisa).toBe(2_000_000);
    expect(r.metalGainPaisa).toBe(2_000_000);
    expect(r.totalProfitPaisa).toBe(4_000_000);
    expect(r.invoicesMissingCost).toBe(1);
  });

  it('excludes sales outside the requested range', () => {
    const a = makeRing(db, 'R1', 20_000);
    const b = makeRing(db, 'R2', 20_000);
    setIntakeRate(db, a, 2_400_000);
    setIntakeRate(db, b, 2_400_000);
    sell(db, a, 20_000, '2026-07-27T10:00:00.000Z');
    sell(db, b, 20_000, '2026-08-05T10:00:00.000Z');

    const july = profitReport(db, '2026-07-01', '2026-07-31');
    expect(july.invoiceCount).toBe(1);
    expect(july.rows[0].docDate.slice(0, 7)).toBe('2026-07');
  });

  it('does not count an old-gold purchase as margin', () => {
    const ring = makeRing(db, 'R1', 20_000);
    setIntakeRate(db, ring, 2_400_000);
    const p22 = purity(db, '22K / 916');

    const metal = 50_000_000;
    const making = 1_000_000;
    const exchange = Math.round((10_000 * 9160 * 2_500_000) / (10_000 * 1000));
    checkout(db, 1, {
      dateISO: '2026-07-27T10:00:00.000Z',
      role: 'OWNER',
      saleLines: [
        {
          itemId: ring,
          pieces: 1,
          netMg: 20_000,
          grossMg: 20_000,
          purityId: p22,
          wastageBp: 0,
          making: { mode: 'PER_GRAM', ratePaisa: 50_000 },
          stones: [],
          hallmarkChargePaisa: 0,
          discountPaisa: 0,
          description: 'Gold Ring 20g',
        },
      ],
      oldGoldLines: [
        { purityId: p22, netMg: 10_000, grossMg: 10_000, touchBp: 9160, description: 'Old chain' },
      ],
      payments: [{ method: 'CASH', amountPaisa: metal + making - exchange }],
    });

    const r = profitReport(db, '2026-07-01', '2026-07-31');
    // Earned is the making on the sold ring only — the scrap line adds none.
    expect(r.earnedPaisa).toBe(1_000_000);
  });
});

describe('deadStockReport', () => {
  it('ignores stock that moved recently', () => {
    makeRing(db, 'R1', 20_000);
    const r = deadStockReport(db, 180);
    expect(r.itemCount).toBe(0);
    expect(r.totalLockedPaisa).toBe(0);
  });

  it('lists a piece that has not moved past the threshold, valued at today rate', () => {
    makeRingAged(db, 'R1', 20_000, 400);

    const r = deadStockReport(db, 180);
    expect(r.itemCount).toBe(1);
    expect(r.rows[0].tagNumber).toBe('R1');
    expect(r.rows[0].daysResting).toBeGreaterThanOrEqual(399);
    // 20g at Rs 25,000/g = Rs 500,000 = 50,000,000 paisa.
    expect(r.rows[0].lockedValuePaisa).toBe(50_000_000);
    expect(r.totalLockedPaisa).toBe(50_000_000);
  });

  it('ranks the most valuable sleeping stock first', () => {
    makeRingAged(db, 'SMALL', 5_000, 400);
    makeRingAged(db, 'BIG', 40_000, 400);

    const r = deadStockReport(db, 180);
    expect(r.rows.map((x) => x.tagNumber)).toEqual(['BIG', 'SMALL']);
  });

  it('drops a piece out of the report once it sells', () => {
    const ring = makeRingAged(db, 'R1', 20_000, 400);
    expect(deadStockReport(db, 180).itemCount).toBe(1);

    sell(db, ring, 20_000);
    // Sold out: no balance left, so nothing is asleep in it any more.
    expect(deadStockReport(db, 180).itemCount).toBe(0);
  });

  it('respects a tighter threshold', () => {
    makeRingAged(db, 'R1', 20_000, 90);

    expect(deadStockReport(db, 180).itemCount).toBe(0);
    expect(deadStockReport(db, 60).itemCount).toBe(1);
  });
});

describe('itemsMissingCost', () => {
  it('lists a piece with no purchase rate recorded', () => {
    makeRing(db, 'R1', 20_000);
    const rows = itemsMissingCost(db);
    expect(rows.map((r) => r.tagNumber)).toEqual(['R1']);
    expect(rows[0].purityLabel).toBe('22K / 916');
  });

  it('drops a piece once its rate is known', () => {
    const ring = makeRing(db, 'R1', 20_000);
    setIntakeRate(db, ring, 2_400_000);
    expect(itemsMissingCost(db)).toEqual([]);
  });

  it('still lists a sold piece, and says so', () => {
    // A sold piece's cost can no longer be observed, but recording it still
    // completes the profit figure on that past sale.
    const ring = makeRing(db, 'R1', 20_000);
    sell(db, ring, 20_000);
    const rows = itemsMissingCost(db);
    expect(rows).toHaveLength(1);
    expect(rows[0].isSold).toBe(true);
  });
});

describe('backfillIntakeRate', () => {
  it('fills every piece of a purity that has no rate', () => {
    makeRing(db, 'R1', 20_000);
    makeRing(db, 'R2', 15_000);

    const n = backfillIntakeRate(db, 1, purity(db, '22K / 916'), 2_400_000);
    expect(n).toBe(2);
    expect(itemsMissingCost(db)).toEqual([]);
  });

  it('never overwrites a rate someone entered by hand', () => {
    const typed = makeRing(db, 'TYPED', 20_000);
    const blank = makeRing(db, 'BLANK', 20_000);
    setIntakeRate(db, typed, 2_600_000);

    const n = backfillIntakeRate(db, 1, purity(db, '22K / 916'), 2_400_000);
    expect(n).toBe(1);

    const kept = db
      .prepare('SELECT intake_rate_paisa_per_gram AS r FROM item_costs WHERE item_id=?')
      .get(typed) as { r: number };
    expect(kept.r).toBe(2_600_000);

    const filled = db
      .prepare('SELECT intake_rate_paisa_per_gram AS r FROM item_costs WHERE item_id=?')
      .get(blank) as { r: number };
    expect(filled.r).toBe(2_400_000);
  });

  it('fills a rate onto a cost row that only had labour', () => {
    // The INSERT..SELECT path skips these, so the UPDATE pass must catch them.
    const ring = makeRing(db, 'R1', 20_000);
    db.prepare(
      `INSERT INTO item_costs (item_id, labour_paid_paisa, updated_by) VALUES (?, 500000, 1)`,
    ).run(ring);

    expect(backfillIntakeRate(db, 1, purity(db, '22K / 916'), 2_400_000)).toBe(1);
    const row = db
      .prepare(
        'SELECT intake_rate_paisa_per_gram AS r, labour_paid_paisa AS l FROM item_costs WHERE item_id=?',
      )
      .get(ring) as { r: number; l: number };
    expect(row.r).toBe(2_400_000);
    // The labour figure that was already there survives.
    expect(row.l).toBe(500_000);
  });

  it('leaves other purities alone', () => {
    makeRing(db, 'GOLD22', 20_000);
    makeRing(db, 'GOLD24', 20_000, { purityId: purity(db, '24K / 999') });

    backfillIntakeRate(db, 1, purity(db, '22K / 916'), 2_400_000);
    expect(itemsMissingCost(db).map((r) => r.tagNumber)).toEqual(['GOLD24']);
  });

  it('refuses a zero or negative rate', () => {
    // "Bought free" would report the whole sale price as profit.
    expect(() => backfillIntakeRate(db, 1, purity(db, '22K / 916'), 0)).toThrow(/more than zero/);
  });

  it('completes the profit report it was missing', () => {
    const ring = makeRing(db, 'R1', 20_000);
    sell(db, ring, 20_000);
    expect(profitReport(db, '2026-07-01', '2026-07-31').invoicesMissingCost).toBe(1);

    backfillIntakeRate(db, 1, purity(db, '22K / 916'), 2_400_000);

    const r = profitReport(db, '2026-07-01', '2026-07-31');
    expect(r.invoicesMissingCost).toBe(0);
    expect(r.metalGainPaisa).toBe(2_000_000);
    expect(r.totalProfitPaisa).toBe(3_000_000);
  });
});
