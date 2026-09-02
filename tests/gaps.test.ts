import { describe, it, expect, beforeEach } from 'vitest';
import { openDatabase, type DB } from '../src/main/db/connection.js';
import { createItem, listItems } from '../src/main/services/itemService.js';
import { enterRate, quoteWeight } from '../src/main/services/rateService.js';
import { rawIntake } from '../src/main/services/karigarService.js';
import { checkout } from '../src/main/services/invoiceService.js';
import { getBalance } from '../src/main/services/ledgerService.js';
import { CreateItemInput } from '../src/shared/contracts/index.js';

let db: DB;

function purity(d: DB, label: string) {
  return (d.prepare('SELECT id FROM purities WHERE label=?').get(label) as { id: number }).id;
}
function gold(d: DB) {
  return (d.prepare(`SELECT id FROM metals WHERE name='Gold'`).get() as { id: number }).id;
}
function silver(d: DB) {
  return (d.prepare(`SELECT id FROM metals WHERE name='Silver'`).get() as { id: number }).id;
}

beforeEach(() => {
  db = openDatabase({ filename: ':memory:' });
  db.prepare(
    `INSERT INTO users (id, username, display_name, pin_hash, role) VALUES (1,'owner','Owner','x','OWNER')`,
  ).run();
  db.prepare(`UPDATE app_settings SET value='300' WHERE key='tax_rate_bp'`).run();
  db.prepare(`UPDATE app_settings SET value='TOTAL_MINUS_METAL' WHERE key='tax_base'`).run();
});

describe('Gap 3: item accepts gross + net, derives less', () => {
  it('derives lessMg from gross - net when not supplied (stone-set piece)', () => {
    // gross 4100, net 3900, no lessMg → should succeed with less=200
    const input = CreateItemInput.parse({
      trackingMode: 'ITEM',
      name: 'Diamond Ring',
      tagNumber: 'DR-1',
      productTypeId: 1,
      metalId: gold(db),
      purityId: purity(db, '22K / 916'),
      stoneTypeId: 4,
      makingTypeId: 1,
      originKind: 'IN_HOUSE',
      grossMg: 4100,
      netMg: 3900,
      makingMode: 'PER_GRAM',
      makingRatePaisa: 1200,
      locationId: 1,
      openingPieces: 1,
    });
    expect(input.lessMg).toBe(200);
    const { id } = createItem(db, 1, 'OWNER', input);
    const item = db.prepare('SELECT gross_mg, less_mg, net_mg FROM items WHERE id=?').get(id) as {
      gross_mg: number;
      less_mg: number;
      net_mg: number;
    };
    expect(item.less_mg).toBe(200);
    expect(item.net_mg).toBe(3900);
  });

  it('still rejects genuinely inconsistent weights (net > gross)', () => {
    expect(() =>
      CreateItemInput.parse({
        trackingMode: 'ITEM',
        name: 'Bad',
        productTypeId: 1,
        metalId: gold(db),
        purityId: purity(db, '22K / 916'),
        stoneTypeId: 1,
        makingTypeId: 1,
        originKind: 'IN_HOUSE',
        grossMg: 3900,
        netMg: 4100, // net > gross, impossible
        lessMg: 0,
        makingMode: 'PER_GRAM',
        makingRatePaisa: 0,
        locationId: 1,
      }),
    ).toThrow();
  });
});

describe('Gap 2: internal lots hidden from item list', () => {
  it('excludes RAW- and SCRAP- lots', () => {
    // create a normal item + a raw metal lot
    createItem(
      db,
      1,
      'OWNER',
      CreateItemInput.parse({
        trackingMode: 'ITEM',
        name: 'Ring',
        tagNumber: 'R1',
        productTypeId: 1,
        metalId: gold(db),
        purityId: purity(db, '22K / 916'),
        stoneTypeId: 1,
        makingTypeId: 1,
        originKind: 'IN_HOUSE',
        grossMg: 5000,
        netMg: 5000,
        makingMode: 'PER_GRAM',
        makingRatePaisa: 0,
        locationId: 1,
        openingPieces: 1,
      }),
    );
    rawIntake(db, 1, { purityId: purity(db, '22K / 916'), netMg: 100_000 });

    const list = listItems(db, 'OWNER', { limit: 100 });
    const tags = list.map((i) => i.tagNumber);
    expect(tags).toContain('R1');
    expect(tags.some((t) => t?.startsWith('RAW-'))).toBe(false);
  });
});

describe('Gap 1: quoteWeight prices a bulk lot by chosen grams', () => {
  it('prices an arbitrary weight for a lot item', () => {
    const p925 = purity(db, 'Silver 925');
    enterRate(db, 1, { purityId: p925, enteredValuePaisa: 3500, enteredBasis: 'PER_GRAM' });
    const { id } = createItem(
      db,
      1,
      'OWNER',
      CreateItemInput.parse({
        trackingMode: 'LOT',
        name: 'Silver Chains',
        tagNumber: 'LOT-1',
        productTypeId: 5,
        metalId: silver(db),
        purityId: p925,
        stoneTypeId: 1,
        makingTypeId: 1,
        originKind: 'IN_HOUSE',
        grossMg: 0,
        netMg: 0,
        makingMode: 'PER_GRAM',
        makingRatePaisa: 150, // Rs 1.50/g
        locationId: 1,
        openingPieces: 0,
      }),
    );
    // price 40 grams: metal 40g * Rs 35 = 1400 + making 40*1.5 = 60 + tax 3% of 60 = 1.8→2
    const q = quoteWeight(db, id, 40_000);
    expect(q.hasRate).toBe(true);
    expect(q.totalPaisa).toBe(140_000 + 6_000 + 180); // Rs 1462
  });
});

describe('Gap 4: checkout tolerates rounding within a rupee', () => {
  it('accepts a whole-rupee payment that is a few paisa off the exact total', () => {
    const p22 = purity(db, '22K / 916');
    enterRate(db, 1, { purityId: p22, enteredValuePaisa: 2_500_000, enteredBasis: 'PER_GRAM' });
    const { id } = createItem(
      db,
      1,
      'OWNER',
      CreateItemInput.parse({
        trackingMode: 'ITEM',
        name: 'Ring',
        tagNumber: 'RR',
        productTypeId: 1,
        metalId: gold(db),
        purityId: p22,
        stoneTypeId: 1,
        makingTypeId: 1,
        originKind: 'IN_HOUSE',
        grossMg: 8333, // odd weight → fractional paisa in total
        netMg: 8333,
        makingMode: 'PER_GRAM',
        makingRatePaisa: 50_000,
        locationId: 1,
        openingPieces: 1,
      }),
    );
    const doc = db
      .prepare(`INSERT INTO documents (doc_type,status,doc_date,created_by) VALUES ('SALE_INVOICE','DRAFT','2026-08-07',1)`)
      .run();
    void doc;
    // Use checkout (opens its own draft). Pay a clean rupee figure with adjustment 0;
    // the server should accept it if within Rs 1 of the computed total.
    const res = checkout(db, 1, {
      dateISO: '2026-08-07T10:00:00.000Z',
      saleLines: [
        {
          itemId: id,
          pieces: 1,
          netMg: 8333,
          grossMg: 8333,
          purityId: p22,
          wastageBp: 0,
          making: { mode: 'PER_GRAM', ratePaisa: 50_000 },
          stones: [],
          hallmarkChargePaisa: 0,
          discountPaisa: 0,
          description: 'Ring',
        },
      ],
      oldGoldLines: [],
      // exact computed total is 21,261,700 (metal 20,832,500 + making 416,650 +
      // tax 12,500 → 21,261,650, rounded to rupee = 21,261,700). Pay the clean
      // whole-rupee figure; it's 50 paisa off the raw total but within Rs 1.
      payments: [{ method: 'CASH', amountPaisa: 21_261_700 }],
      saleAdjustmentPaisa: 0,
    });
    expect(res.grandTotalPaisa).toBe(21_261_700);
    expect(getBalance(db, id).pieces).toBe(0); // sold
  });
});
