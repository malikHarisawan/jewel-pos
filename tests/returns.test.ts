/**
 * Sale returns. Before this a mistake at the counter was permanent — no void,
 * no refund, no way to put a ring back on the shelf.
 *
 * The rules these tests pin down:
 *  - money goes back at the ORIGINAL price, never today's rate;
 *  - stock returns through the ledger, and a unique piece becomes sellable;
 *  - nothing can be returned twice;
 *  - the original invoice is never modified.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { openDatabase, type DB } from '../src/main/db/connection.js';
import { createItem } from '../src/main/services/itemService.js';
import { enterRate } from '../src/main/services/rateService.js';
import {
  checkout,
  returnSale,
  getReturnableLines,
  getInvoice,
  listInvoices,
} from '../src/main/services/invoiceService.js';
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

let seq = 0;
function makeRing(netMg: number) {
  const input = CreateItemInput.parse({
    trackingMode: 'ITEM',
    name: `Ring ${++seq}`,
    tagNumber: `R-${seq}`,
    productTypeId: 1,
    metalId: gold(db),
    purityId: purity(db, '22K / 916'),
    stoneTypeId: 1,
    makingTypeId: 1,
    originKind: 'IN_HOUSE',
    grossMg: netMg,
    netMg,
    makingMode: 'PER_GRAM',
    makingRatePaisa: 0,
    locationId: 1,
    openingPieces: 1,
  });
  return createItem(db, 1, 'OWNER', input).id;
}

function makeLot(netMg: number) {
  const input = CreateItemInput.parse({
    trackingMode: 'LOT',
    name: `Chain lot ${++seq}`,
    tagNumber: `L-${seq}`,
    productTypeId: 1,
    metalId: gold(db),
    purityId: purity(db, '22K / 916'),
    stoneTypeId: 1,
    makingTypeId: 1,
    originKind: 'IN_HOUSE',
    grossMg: netMg,
    netMg,
    makingMode: 'PER_GRAM',
    makingRatePaisa: 0,
    locationId: 1,
    openingPieces: 10,
    openingNetMg: netMg,
    openingGrossMg: netMg,
  });
  return createItem(db, 1, 'OWNER', input).id;
}

const SALE_DATE = '2026-09-02T10:00:00.000Z';

/** Sell one ring of `netMg` at Rs 10,000/g. */
function sellRing(netMg: number) {
  const ring = makeRing(netMg);
  const res = checkout(db, 1, {
    dateISO: SALE_DATE,
    role: 'OWNER',
    saleLines: [
      {
        itemId: ring,
        pieces: 1,
        netMg,
        grossMg: netMg,
        purityId: purity(db, '22K / 916'),
        wastageBp: 0,
        making: { mode: 'PER_GRAM', ratePaisa: 0 },
        stones: [],
        hallmarkChargePaisa: 0,
        discountPaisa: 0,
        description: 'Ring',
      },
    ],
    oldGoldLines: [],
    payments: [{ method: 'CASH', amountPaisa: netMg * 1_000 }],
  });
  return { ring, res };
}

beforeEach(() => {
  seq = 0;
  db = openDatabase({ filename: ':memory:' });
  db.prepare(
    `INSERT INTO users (id, username, display_name, pin_hash, role)
     VALUES (1,'owner','Shop Owner','x','OWNER')`,
  ).run();
  db.prepare(`UPDATE app_settings SET value='0' WHERE key='tax_rate_bp'`).run();
  enterRate(db, 1, {
    purityId: purity(db, '22K / 916'),
    enteredValuePaisa: 1_000_000, // Rs 10,000/g
    enteredBasis: 'PER_GRAM',
  });
});

describe('returning a whole sale', () => {
  it('refunds the money, restocks the piece and makes it sellable again', () => {
    const { ring, res } = sellRing(10_000); // Rs 1,00,000
    expect(getBalance(db, ring).pieces).toBe(0);

    const [line] = getReturnableLines(db, res.documentId);
    const ret = returnSale(db, 1, {
      documentId: res.documentId,
      dateISO: '2026-09-03T10:00:00.000Z',
      lines: [{ lineId: line.lineId, pieces: 1, netMg: 10_000 }],
    });

    // Money back, as a negative document.
    expect(ret.grandTotalPaisa).toBe(-10_000_000);
    expect(ret.docNumber).toMatch(/^RET-2026-/);

    // Metal back on the shelf, and the piece can be sold again.
    expect(getBalance(db, ring).pieces).toBe(1);
    expect(getBalance(db, ring).netMg).toBe(10_000);
    expect(
      (db.prepare('SELECT status FROM items WHERE id=?').get(ring) as { status: string }).status,
    ).toBe('IN_STOCK');
  });

  it('refunds at the original price even after the rate moves', () => {
    const { res } = sellRing(10_000); // sold at Rs 10,000/g => Rs 1,00,000

    // Gold jumps 50% overnight. The customer must still get back exactly what
    // they paid — not more, not less.
    enterRate(db, 1, {
      purityId: purity(db, '22K / 916'),
      enteredValuePaisa: 1_500_000,
      enteredBasis: 'PER_GRAM',
    });

    const [line] = getReturnableLines(db, res.documentId);
    const ret = returnSale(db, 1, {
      documentId: res.documentId,
      dateISO: '2026-09-03T10:00:00.000Z',
      lines: [{ lineId: line.lineId, pieces: 1, netMg: 10_000 }],
    });
    expect(ret.grandTotalPaisa).toBe(-10_000_000);
  });

  it('writes the refund as a negative payment so takings net out', () => {
    const { res } = sellRing(10_000);
    const [line] = getReturnableLines(db, res.documentId);
    const ret = returnSale(db, 1, {
      documentId: res.documentId,
      dateISO: '2026-09-03T10:00:00.000Z',
      lines: [{ lineId: line.lineId, pieces: 1, netMg: 10_000 }],
      refundMethod: 'CASH',
    });

    const paid = (
      db.prepare('SELECT SUM(amount_paisa) s FROM payments').get() as { s: number }
    ).s;
    expect(paid).toBe(0); // Rs 1,00,000 in, Rs 1,00,000 out

    const refund = db
      .prepare('SELECT method, amount_paisa FROM payments WHERE document_id=?')
      .get(ret.documentId) as { method: string; amount_paisa: number };
    expect(refund.amount_paisa).toBe(-10_000_000);
    expect(refund.method).toBe('CASH');
  });

  it('leaves the original invoice untouched', () => {
    const { res } = sellRing(10_000);
    const before = getInvoice(db, res.documentId);

    const [line] = getReturnableLines(db, res.documentId);
    returnSale(db, 1, {
      documentId: res.documentId,
      dateISO: '2026-09-03T10:00:00.000Z',
      lines: [{ lineId: line.lineId, pieces: 1, netMg: 10_000 }],
    });

    const after = getInvoice(db, res.documentId);
    expect(after.grandTotalPaisa).toBe(before.grandTotalPaisa);
    expect(after.docNumber).toBe(before.docNumber);
    expect(after.lines).toHaveLength(before.lines.length);
  });

  it('keeps the audit chain verifiable through the return', () => {
    const { res } = sellRing(10_000);
    const [line] = getReturnableLines(db, res.documentId);
    returnSale(db, 1, {
      documentId: res.documentId,
      dateISO: '2026-09-03T10:00:00.000Z',
      lines: [{ lineId: line.lineId, pieces: 1, netMg: 10_000 }],
    });
    expect(verifyAuditChain(db).ok).toBe(true);
  });
});

describe('partial returns', () => {
  it('gives back part of a lot and refunds pro rata', () => {
    const lot = makeLot(50_000); // 50g
    const res = checkout(db, 1, {
      dateISO: SALE_DATE,
      role: 'OWNER',
      saleLines: [
        {
          itemId: lot,
          pieces: 2,
          netMg: 20_000, // sell 20g
          grossMg: 20_000,
          purityId: purity(db, '22K / 916'),
          wastageBp: 0,
          making: { mode: 'PER_GRAM', ratePaisa: 0 },
          stones: [],
          hallmarkChargePaisa: 0,
          discountPaisa: 0,
          description: '20g chain',
        },
      ],
      oldGoldLines: [],
      payments: [{ method: 'CASH', amountPaisa: 20_000_000 }],
    });

    const [line] = getReturnableLines(db, res.documentId);
    // Customer brings back 5g of the 20g.
    const ret = returnSale(db, 1, {
      documentId: res.documentId,
      dateISO: '2026-09-03T10:00:00.000Z',
      lines: [{ lineId: line.lineId, pieces: 1, netMg: 5_000 }],
    });
    expect(ret.grandTotalPaisa).toBe(-5_000_000); // a quarter of the line

    // A LOT opens at netMg per piece, so 50g x 10 pieces = 500g on the shelf.
    // 20g went out, 5g came back: 15g is still with the customer.
    const opening = 50_000 * 10;
    expect(getBalance(db, lot).netMg).toBe(opening - 20_000 + 5_000);
  });

  it('tracks what is left after each partial return', () => {
    const lot = makeLot(50_000);
    const res = checkout(db, 1, {
      dateISO: SALE_DATE,
      role: 'OWNER',
      saleLines: [
        {
          itemId: lot,
          pieces: 2,
          netMg: 20_000,
          grossMg: 20_000,
          purityId: purity(db, '22K / 916'),
          wastageBp: 0,
          making: { mode: 'PER_GRAM', ratePaisa: 0 },
          stones: [],
          hallmarkChargePaisa: 0,
          discountPaisa: 0,
          description: '20g chain',
        },
      ],
      oldGoldLines: [],
      payments: [{ method: 'CASH', amountPaisa: 20_000_000 }],
    });

    const [line] = getReturnableLines(db, res.documentId);
    returnSale(db, 1, {
      documentId: res.documentId,
      dateISO: '2026-09-03T10:00:00.000Z',
      lines: [{ lineId: line.lineId, pieces: 1, netMg: 5_000 }],
    });

    const [after] = getReturnableLines(db, res.documentId);
    expect(after.returnedNetMg).toBe(5_000);
    expect(after.remainingNetMg).toBe(15_000);
    expect(after.remainingPieces).toBe(1);
  });
});

describe('what a return must refuse', () => {
  it('refuses to return the same piece twice', () => {
    const { res } = sellRing(10_000);
    const [line] = getReturnableLines(db, res.documentId);
    const give = () =>
      returnSale(db, 1, {
        documentId: res.documentId,
        dateISO: '2026-09-03T10:00:00.000Z',
        lines: [{ lineId: line.lineId, pieces: 1, netMg: 10_000 }],
      });
    give();
    expect(give).toThrow(/only 0 left/);
  });

  it('refuses more weight than was sold', () => {
    const { res } = sellRing(10_000);
    const [line] = getReturnableLines(db, res.documentId);
    expect(() =>
      returnSale(db, 1, {
        documentId: res.documentId,
        dateISO: '2026-09-03T10:00:00.000Z',
        lines: [{ lineId: line.lineId, pieces: 1, netMg: 12_000 }],
      }),
    ).toThrow(/more than was sold/);
  });

  it('refuses a line belonging to a different bill', () => {
    const a = sellRing(10_000);
    const b = sellRing(5_000);
    const [lineOfB] = getReturnableLines(db, b.res.documentId);
    expect(() =>
      returnSale(db, 1, {
        documentId: a.res.documentId,
        dateISO: '2026-09-03T10:00:00.000Z',
        lines: [{ lineId: lineOfB.lineId, pieces: 1, netMg: 5_000 }],
      }),
    ).toThrow(/not part of invoice/);
  });

  it('refuses an empty return and a zero quantity', () => {
    const { res } = sellRing(10_000);
    const [line] = getReturnableLines(db, res.documentId);
    expect(() =>
      returnSale(db, 1, { documentId: res.documentId, dateISO: SALE_DATE, lines: [] }),
    ).toThrow(/at least one line/);
    expect(() =>
      returnSale(db, 1, {
        documentId: res.documentId,
        dateISO: SALE_DATE,
        lines: [{ lineId: line.lineId, pieces: 1, netMg: 0 }],
      }),
    ).toThrow(/positive quantity/);
  });

  it('refuses to return a return', () => {
    const { res } = sellRing(10_000);
    const [line] = getReturnableLines(db, res.documentId);
    const ret = returnSale(db, 1, {
      documentId: res.documentId,
      dateISO: '2026-09-03T10:00:00.000Z',
      lines: [{ lineId: line.lineId, pieces: 1, netMg: 10_000 }],
    });
    expect(() => getReturnableLines(db, ret.documentId)).toThrow(/only a sale invoice/);
  });

  it('never offers the old-gold line as returnable', () => {
    const ring = makeRing(10_000);
    const res = checkout(db, 1, {
      dateISO: SALE_DATE,
      role: 'OWNER',
      saleLines: [
        {
          itemId: ring,
          pieces: 1,
          netMg: 10_000,
          grossMg: 10_000,
          purityId: purity(db, '22K / 916'),
          wastageBp: 0,
          making: { mode: 'PER_GRAM', ratePaisa: 0 },
          stones: [],
          hallmarkChargePaisa: 0,
          discountPaisa: 0,
          description: 'Ring',
        },
      ],
      oldGoldLines: [
        {
          purityId: purity(db, '22K / 916'),
          netMg: 5_000,
          grossMg: 5_000,
          touchBp: 10_000,
          description: 'Old bangle',
        },
      ],
      payments: [{ method: 'CASH', amountPaisa: 5_000_000 }],
    });

    // The customer sold that metal to the shop; it is not the shop's to return.
    const lines = getReturnableLines(db, res.documentId);
    expect(lines).toHaveLength(1);
    expect(lines[0].description).toBe('Ring');
  });
});

describe('the register shows returns', () => {
  it('does not list a return among sales', () => {
    const { res } = sellRing(10_000);
    const [line] = getReturnableLines(db, res.documentId);
    returnSale(db, 1, {
      documentId: res.documentId,
      dateISO: '2026-09-03T10:00:00.000Z',
      lines: [{ lineId: line.lineId, pieces: 1, netMg: 10_000 }],
    });
    // The sales register lists SALE_INVOICE only; the return is its own doc type.
    const rows = listInvoices(db);
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(res.documentId);
  });
});

describe('document numbering survives a year roll-over', () => {
  it('issues numbers in a fiscal year that was never seeded', () => {
    // Only 2026 was seeded originally; a sale on 1 Jan 2031 must still bill.
    const ring = makeRing(1_000);
    const res = checkout(db, 1, {
      dateISO: '2031-01-01T09:00:00.000Z',
      role: 'OWNER',
      saleLines: [
        {
          itemId: ring,
          pieces: 1,
          netMg: 1_000,
          grossMg: 1_000,
          purityId: purity(db, '22K / 916'),
          wastageBp: 0,
          making: { mode: 'PER_GRAM', ratePaisa: 0 },
          stones: [],
          hallmarkChargePaisa: 0,
          discountPaisa: 0,
          description: 'Ring',
        },
      ],
      oldGoldLines: [],
      payments: [{ method: 'CASH', amountPaisa: 1_000_000 }],
    });
    expect(res.docNumber).toBe('INV-2031-0001');
  });
});
