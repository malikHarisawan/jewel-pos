import { describe, it, expect, beforeEach } from 'vitest';
import { openDatabase, type DB } from '../src/main/db/connection.js';
import { createItem } from '../src/main/services/itemService.js';
import { enterRate } from '../src/main/services/rateService.js';
import { checkout, getInvoice } from '../src/main/services/invoiceService.js';
import { getBalance } from '../src/main/services/ledgerService.js';
import { verifyAuditChain } from '../src/main/db/audit.js';
import { CreateItemInput } from '../src/shared/contracts/index.js';

let db: DB;

function purity(d: DB, label: string) {
  return (d.prepare('SELECT id FROM purities WHERE label=?').get(label) as { id: number }).id;
}
function gold(d: DB) {
  return (d.prepare(`SELECT id FROM metals WHERE name='Gold'`).get() as { id: number }).id;
}

function makeRing(d: DB, tag: string, netMg: number) {
  const input = CreateItemInput.parse({
    trackingMode: 'ITEM',
    name: `Ring ${tag}`,
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
    openingPieces: 1, // in stock, ready to sell
  });
  return createItem(d, 1, 'OWNER', input).id;
}

beforeEach(() => {
  db = openDatabase({ filename: ':memory:' });
  db.prepare(
    `INSERT INTO users (id, username, display_name, pin_hash, role) VALUES (1,'owner','Owner','x','OWNER')`,
  ).run();
  db.prepare(`UPDATE app_settings SET value='300' WHERE key='tax_rate_bp'`).run();
  db.prepare(`UPDATE app_settings SET value='TOTAL_MINUS_METAL' WHERE key='tax_base'`).run();
});

describe('checkout (one-call POS sale)', () => {
  it('sells an item with old-gold exchange and split payment, atomically', () => {
    const p22 = purity(db, '22K / 916');
    enterRate(db, 1, { purityId: p22, enteredValuePaisa: 2_500_000, enteredBasis: 'PER_GRAM' });
    const ring = makeRing(db, 'RING-1', 20_000); // 20g

    // sale line total: metal 50,000,000 + making 1,000,000 + tax 30,000 = 51,030,000
    // old gold 10g @ 91.6% @ 25,000/g = -22,900,000
    // grand = 28,130,000
    const res = checkout(db, 1, {
      dateISO: '2026-07-27T10:00:00.000Z',
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
      payments: [
        { method: 'CASH', amountPaisa: 20_000_000 },
        { method: 'CARD', amountPaisa: 8_130_000 },
      ],
    });

    expect(res.grandTotalPaisa).toBe(28_130_000);
    expect(res.docNumber).toBe('INV-2026-0001');

    // ring is sold out
    expect(getBalance(db, ring).pieces).toBe(0);
    // scrap lot created with 10g
    const scrap = db.prepare(`SELECT id FROM items WHERE tag_number=?`).get(`SCRAP-${p22}`) as {
      id: number;
    };
    expect(getBalance(db, scrap.id).netMg).toBe(10_000);
    // audit chain intact through the nested transaction
    expect(verifyAuditChain(db).ok).toBe(true);
  });

  it('rejects checkout when no rate is set for a purity in the cart', () => {
    const p22 = purity(db, '22K / 916');
    const ring = makeRing(db, 'RING-2', 10_000);
    expect(() =>
      checkout(db, 1, {
        dateISO: '2026-07-27T10:00:00.000Z',
        saleLines: [
          {
            itemId: ring,
            pieces: 1,
            netMg: 10_000,
            grossMg: 10_000,
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
        payments: [{ method: 'CASH', amountPaisa: 1 }],
      }),
    ).toThrow(/no rate set/);
    // nothing persisted
    expect(getBalance(db, ring).pieces).toBe(1);
    expect(db.prepare('SELECT count(*) c FROM documents').get()).toEqual({ c: 0 });
  });

  it('applies a negative adjustment (discount): payments match the reduced total', () => {
    const p22 = purity(db, '22K / 916');
    enterRate(db, 1, { purityId: p22, enteredValuePaisa: 2_500_000, enteredBasis: 'PER_GRAM' });
    const ring = makeRing(db, 'RING-D', 10_000);
    // computed: metal 25,000,000 + making 500,000 + tax 15,000 = 25,515,000
    // discount 515,000 -> charged 25,000,000
    const res = checkout(db, 1, {
      dateISO: '2026-07-27T10:00:00.000Z',
      saleAdjustmentPaisa: -515_000,
      saleLines: [
        {
          itemId: ring,
          pieces: 1,
          netMg: 10_000,
          grossMg: 10_000,
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
      payments: [{ method: 'CASH', amountPaisa: 25_000_000 }],
    });
    expect(res.grandTotalPaisa).toBe(25_000_000);
    const inv = getInvoice(db, res.documentId);
    expect(inv.saleAdjustmentPaisa).toBe(-515_000);
    expect(inv.grandTotalPaisa).toBe(25_000_000);
  });

  it('applies a positive adjustment (round up / surcharge)', () => {
    const p22 = purity(db, '22K / 916');
    enterRate(db, 1, { purityId: p22, enteredValuePaisa: 2_500_000, enteredBasis: 'PER_GRAM' });
    const ring = makeRing(db, 'RING-U', 10_000);
    // computed 25,515,000 + surcharge 485,000 -> charged 26,000,000 (round number)
    const res = checkout(db, 1, {
      dateISO: '2026-07-27T10:00:00.000Z',
      saleAdjustmentPaisa: 485_000,
      saleLines: [
        {
          itemId: ring,
          pieces: 1,
          netMg: 10_000,
          grossMg: 10_000,
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
      payments: [{ method: 'CASH', amountPaisa: 26_000_000 }],
    });
    expect(res.grandTotalPaisa).toBe(26_000_000);
  });

  it('rejects when payments do not match the adjusted total', () => {
    const p22 = purity(db, '22K / 916');
    enterRate(db, 1, { purityId: p22, enteredValuePaisa: 2_500_000, enteredBasis: 'PER_GRAM' });
    const ring = makeRing(db, 'RING-M', 10_000);
    expect(() =>
      checkout(db, 1, {
        dateISO: '2026-07-27T10:00:00.000Z',
        saleAdjustmentPaisa: -515_000,
        saleLines: [
          {
            itemId: ring,
            pieces: 1,
            netMg: 10_000,
            grossMg: 10_000,
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
        payments: [{ method: 'CASH', amountPaisa: 25_515_000 }], // full computed, ignores discount
      }),
    ).toThrow(/do not cover/);
  });

  it('getInvoice returns the finalized invoice for the receipt', () => {
    const p22 = purity(db, '22K / 916');
    enterRate(db, 1, { purityId: p22, enteredValuePaisa: 2_500_000, enteredBasis: 'PER_GRAM' });
    const ring = makeRing(db, 'RING-3', 10_000);
    const res = checkout(db, 1, {
      dateISO: '2026-07-27T10:00:00.000Z',
      saleLines: [
        {
          itemId: ring,
          pieces: 1,
          netMg: 10_000,
          grossMg: 10_000,
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
      payments: [{ method: 'CASH', amountPaisa: 25_515_000 }],
    });
    const inv = getInvoice(db, res.documentId);
    expect(inv.docNumber).toBe('INV-2026-0001');
    expect(inv.lines).toHaveLength(1);
    expect(inv.lines[0].lineTotalPaisa).toBe(25_515_000);
    expect(inv.payments).toEqual([{ method: 'CASH', amountPaisa: 25_515_000 }]);
    expect(inv.grandTotalPaisa).toBe(25_515_000);
  });
});
