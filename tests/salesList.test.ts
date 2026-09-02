/**
 * The sales register. Before this existed a bill vanished the moment the receipt
 * was closed, so these tests pin the things a shopkeeper actually relies on:
 * newest first, date ranges that include the whole end day, search by number and
 * by customer, and drafts never showing up as sales.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { openDatabase, type DB } from '../src/main/db/connection.js';
import { createItem } from '../src/main/services/itemService.js';
import { enterRate } from '../src/main/services/rateService.js';
import { checkout, listInvoices } from '../src/main/services/invoiceService.js';
import { createParty } from '../src/main/services/partyService.js';
import { CreateItemInput } from '../src/shared/contracts/index.js';

let db: DB;

function purity(d: DB, label: string) {
  return (d.prepare('SELECT id FROM purities WHERE label=?').get(label) as { id: number }).id;
}
function gold(d: DB) {
  return (d.prepare(`SELECT id FROM metals WHERE name='Gold'`).get() as { id: number }).id;
}

let tagSeq = 0;
function makeRing(d: DB, netMg: number) {
  const input = CreateItemInput.parse({
    trackingMode: 'ITEM',
    name: `Ring ${++tagSeq}`,
    tagNumber: `R-${tagSeq}`,
    productTypeId: 1,
    metalId: gold(d),
    purityId: purity(d, '22K / 916'),
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
  return createItem(d, 1, 'OWNER', input).id;
}

/** Sell one 1g ring for a clean Rs 10,000 on the given date. */
function sellOn(dateISO: string, customerId?: number) {
  const ring = makeRing(db, 1_000);
  return checkout(db, 1, {
    dateISO,
    role: 'OWNER',
    customerId: customerId ?? null,
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
}

beforeEach(() => {
  tagSeq = 0;
  db = openDatabase({ filename: ':memory:' });
  db.prepare(
    `INSERT INTO users (id, username, display_name, pin_hash, role)
     VALUES (1,'owner','Shop Owner','x','OWNER')`,
  ).run();
  db.prepare(`UPDATE app_settings SET value='0' WHERE key='tax_rate_bp'`).run();
  enterRate(db, 1, {
    purityId: purity(db, '22K / 916'),
    enteredValuePaisa: 1_000_000,
    enteredBasis: 'PER_GRAM',
  });
});

describe('listing sales', () => {
  it('returns nothing on a fresh shop', () => {
    expect(listInvoices(db)).toEqual([]);
  });

  it('lists a finalised sale with the figures the register shows', () => {
    const res = sellOn('2026-09-02T10:00:00.000Z');
    const [row] = listInvoices(db);
    expect(row.id).toBe(res.documentId);
    expect(row.docNumber).toBe(res.docNumber);
    expect(row.grandTotalPaisa).toBe(1_000_000);
    expect(row.status).toBe('FINAL');
    expect(row.lineCount).toBe(1);
    expect(row.cashierName).toBe('Shop Owner');
    expect(row.customerName).toBeNull(); // walk-in
  });

  it('orders newest first, not by insertion', () => {
    sellOn('2026-09-01T10:00:00.000Z');
    sellOn('2026-09-03T10:00:00.000Z');
    sellOn('2026-09-02T10:00:00.000Z');
    expect(listInvoices(db).map((r) => r.docDate.slice(0, 10))).toEqual([
      '2026-09-03',
      '2026-09-02',
      '2026-09-01',
    ]);
  });

  it('names the customer when the sale has one', () => {
    const id = createParty(db, 1, { kind: 'CUSTOMER', name: 'Ayesha Khan' }).id;
    sellOn('2026-09-02T10:00:00.000Z', id);
    expect(listInvoices(db)[0].customerName).toBe('Ayesha Khan');
  });

  it('counts only sale lines, not the old-gold credit', () => {
    const ring = makeRing(db, 1_000);
    checkout(db, 1, {
      dateISO: '2026-09-02T10:00:00.000Z',
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
      oldGoldLines: [
        {
          purityId: purity(db, '22K / 916'),
          netMg: 500,
          grossMg: 500,
          touchBp: 9160,
          description: 'Old gold',
        },
      ],
      payments: [{ method: 'CASH', amountPaisa: 542_000 }],
    });
    // Two document lines exist, but only one of them is something sold.
    expect(listInvoices(db)[0].lineCount).toBe(1);
  });
});

describe('date filtering', () => {
  beforeEach(() => {
    sellOn('2026-08-20T10:00:00.000Z');
    sellOn('2026-09-01T10:00:00.000Z');
    sellOn('2026-09-02T18:30:00.000Z'); // late in the day
  });

  it('includes sales made late on the to-date', () => {
    // The naive `doc_date <= '2026-09-02'` compare would drop an 18:30 sale,
    // making the day's takings look wrong to the shopkeeper.
    const rows = listInvoices(db, { fromDate: '2026-09-02', toDate: '2026-09-02' });
    expect(rows).toHaveLength(1);
    expect(rows[0].docDate.startsWith('2026-09-02')).toBe(true);
  });

  it('filters from a start date', () => {
    expect(listInvoices(db, { fromDate: '2026-09-01' })).toHaveLength(2);
  });

  it('filters to an end date', () => {
    expect(listInvoices(db, { toDate: '2026-08-31' })).toHaveLength(1);
  });
});

describe('search', () => {
  it('finds a bill by its number', () => {
    const res = sellOn('2026-09-02T10:00:00.000Z');
    sellOn('2026-09-02T11:00:00.000Z');
    const rows = listInvoices(db, { search: res.docNumber });
    expect(rows).toHaveLength(1);
    expect(rows[0].docNumber).toBe(res.docNumber);
  });

  it('finds bills by customer name, case-insensitively and on a partial', () => {
    const id = createParty(db, 1, { kind: 'CUSTOMER', name: 'Ayesha Khan' }).id;
    sellOn('2026-09-02T10:00:00.000Z', id);
    sellOn('2026-09-02T11:00:00.000Z'); // walk-in, must not match
    expect(listInvoices(db, { search: 'ayesha' })).toHaveLength(1);
    expect(listInvoices(db, { search: 'Khan' })).toHaveLength(1);
  });

  it('returns nothing for a search that matches no bill', () => {
    sellOn('2026-09-02T10:00:00.000Z');
    expect(listInvoices(db, { search: 'nobody' })).toEqual([]);
  });
});

describe('what the register must not show', () => {
  it('hides DRAFT documents — an abandoned checkout is not a sale', () => {
    sellOn('2026-09-02T10:00:00.000Z');
    // A draft left behind by a checkout that threw before finalising.
    db.prepare(
      `INSERT INTO documents (doc_type, status, doc_date, created_by)
       VALUES ('SALE_INVOICE','DRAFT','2026-09-02T12:00:00.000Z',1)`,
    ).run();
    // Only the real sale comes back; the draft is absent entirely rather than
    // listed with a DRAFT status.
    const rows = listInvoices(db);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('FINAL');
  });

  it('hides non-sale documents such as karigar vouchers', () => {
    sellOn('2026-09-02T10:00:00.000Z');
    db.prepare(
      `INSERT INTO documents (doc_type, status, doc_date, created_by)
       VALUES ('KARIGAR_VOUCHER','FINAL','2026-09-02T12:00:00.000Z',1)`,
    ).run();
    expect(listInvoices(db)).toHaveLength(1);
  });
});

describe('paging', () => {
  it('honours limit and offset against the newest-first order', () => {
    sellOn('2026-09-01T10:00:00.000Z');
    sellOn('2026-09-02T10:00:00.000Z');
    sellOn('2026-09-03T10:00:00.000Z');
    expect(listInvoices(db, { limit: 2 }).map((r) => r.docDate.slice(0, 10))).toEqual([
      '2026-09-03',
      '2026-09-02',
    ]);
    expect(listInvoices(db, { limit: 2, offset: 2 }).map((r) => r.docDate.slice(0, 10))).toEqual([
      '2026-09-01',
    ]);
  });
});
