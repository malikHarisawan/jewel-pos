/**
 * Customer credit (udhaar).
 *
 * CREDIT was previously a payment method that recorded nothing: the sale
 * completed, the money never arrived, and no row anywhere said who owed it.
 * These tests pin the whole loop — a credit sale creates a debt, repayments
 * reduce it, returns can write it off, and the ledger cannot be rewritten.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { openDatabase, type DB } from '../src/main/db/connection.js';
import { createItem } from '../src/main/services/itemService.js';
import { enterRate } from '../src/main/services/rateService.js';
import { checkout, returnSale, getReturnableLines } from '../src/main/services/invoiceService.js';
import { createParty } from '../src/main/services/partyService.js';
import {
  getBalance,
  getStatement,
  listDebtors,
  recordRepayment,
  postEntry,
} from '../src/main/services/creditService.js';
import { verifyAuditChain } from '../src/main/db/audit.js';
import { CreateItemInput } from '../src/shared/contracts/index.js';

let db: DB;
let customer: number;

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

const DATE = '2026-09-02T10:00:00.000Z';

/**
 * Sell a 10g ring (Rs 1,00,000) splitting the bill between cash and credit.
 * `customerId` is passed through so the "no customer" case can be exercised.
 */
function sellOnCredit(creditPaisa: number, customerId?: number | null) {
  const ring = makeRing(10_000);
  const total = 10_000_000;
  const cash = total - creditPaisa;
  const payments: { method: 'CASH' | 'CREDIT'; amountPaisa: number }[] = [];
  if (cash > 0) payments.push({ method: 'CASH', amountPaisa: cash });
  if (creditPaisa > 0) payments.push({ method: 'CREDIT', amountPaisa: creditPaisa });

  return checkout(db, 1, {
    dateISO: DATE,
    role: 'OWNER',
    customerId: customerId === undefined ? customer : customerId,
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
    oldGoldLines: [],
    payments,
  });
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
    enteredValuePaisa: 1_000_000,
    enteredBasis: 'PER_GRAM',
  });
  customer = createParty(db, 1, { kind: 'CUSTOMER', name: 'Ayesha Khan', phone: '0300-1234567' }).id;
});

describe('a credit sale creates a real debt', () => {
  it('records the full amount when nothing is paid', () => {
    const res = sellOnCredit(10_000_000);
    expect(getBalance(db, customer)).toBe(10_000_000);

    const [entry] = getStatement(db, customer);
    expect(entry.entryType).toBe('CREDIT_SALE');
    expect(entry.amountPaisa).toBe(10_000_000);
    expect(entry.documentId).toBe(res.documentId);
    expect(entry.docNumber).toBe(res.docNumber);
  });

  it('records only the unpaid part of a split payment', () => {
    // Rs 40,000 cash now, Rs 60,000 on the book.
    sellOnCredit(6_000_000);
    expect(getBalance(db, customer)).toBe(6_000_000);
  });

  it('records nothing when the bill is paid in full', () => {
    sellOnCredit(0);
    expect(getBalance(db, customer)).toBe(0);
    expect(getStatement(db, customer)).toEqual([]);
  });

  it('refuses a credit sale with no customer — the debt would vanish', () => {
    // This is the bug the whole feature exists to close.
    expect(() => sellOnCredit(10_000_000, null)).toThrow(/needs a customer/);
  });

  it('rolls the whole sale back when the credit line is refused', () => {
    const before = db.prepare('SELECT count(*) c FROM documents').get() as { c: number };
    expect(() => sellOnCredit(10_000_000, null)).toThrow();
    const after = db.prepare('SELECT count(*) c FROM documents').get() as { c: number };
    // No orphan draft, no stock movement, no half-sale.
    expect(after.c).toBe(before.c);
    expect(
      (db.prepare('SELECT count(*) c FROM stock_movements WHERE movement_type=?').get('SALE_OUT') as {
        c: number;
      }).c,
    ).toBe(0);
  });

  it('accumulates across several credit sales', () => {
    sellOnCredit(3_000_000);
    sellOnCredit(2_000_000);
    expect(getBalance(db, customer)).toBe(5_000_000);
    expect(getStatement(db, customer)).toHaveLength(2);
  });
});

describe('repayments', () => {
  beforeEach(() => {
    sellOnCredit(10_000_000); // owes Rs 1,00,000
  });

  it('reduces the balance and keeps a running total', () => {
    const r = recordRepayment(db, 1, {
      partyId: customer,
      amountPaisa: 3_000_000,
      method: 'CASH',
      entryDate: '2026-09-05T10:00:00.000Z',
    });
    expect(r.balancePaisa).toBe(7_000_000);

    const st = getStatement(db, customer);
    expect(st).toHaveLength(2);
    expect(st[0].balanceAfterPaisa).toBe(10_000_000);
    expect(st[1].amountPaisa).toBe(-3_000_000);
    expect(st[1].balanceAfterPaisa).toBe(7_000_000);
    expect(st[1].method).toBe('CASH');
  });

  it('settles the account exactly', () => {
    const r = recordRepayment(db, 1, {
      partyId: customer,
      amountPaisa: 10_000_000,
      method: 'BANK',
      entryDate: '2026-09-05T10:00:00.000Z',
    });
    expect(r.balancePaisa).toBe(0);
  });

  it('refuses to take more than is owed', () => {
    // Nearly always a typo at the counter; silently creating a negative balance
    // would hide it until it is much harder to unpick.
    expect(() =>
      recordRepayment(db, 1, {
        partyId: customer,
        amountPaisa: 10_000_001,
        method: 'CASH',
        entryDate: '2026-09-05T10:00:00.000Z',
      }),
    ).toThrow(/more than the/);
    expect(getBalance(db, customer)).toBe(10_000_000);
  });

  it('refuses a zero or negative repayment', () => {
    for (const amt of [0, -500]) {
      expect(() =>
        recordRepayment(db, 1, {
          partyId: customer,
          amountPaisa: amt,
          method: 'CASH',
          entryDate: '2026-09-05T10:00:00.000Z',
        }),
      ).toThrow(/positive amount/);
    }
  });

  it('refuses a repayment against a settled account', () => {
    recordRepayment(db, 1, {
      partyId: customer,
      amountPaisa: 10_000_000,
      method: 'CASH',
      entryDate: '2026-09-05T10:00:00.000Z',
    });
    expect(() =>
      recordRepayment(db, 1, {
        partyId: customer,
        amountPaisa: 100,
        method: 'CASH',
        entryDate: '2026-09-06T10:00:00.000Z',
      }),
    ).toThrow(/nothing outstanding/);
  });
});

describe('who owes money', () => {
  it('lists debtors biggest first and omits settled accounts', () => {
    const b = createParty(db, 1, { kind: 'CUSTOMER', name: 'Bilal' }).id;
    const c = createParty(db, 1, { kind: 'CUSTOMER', name: 'Cusp' }).id;

    postEntry(db, 1, {
      partyId: customer,
      entryType: 'CREDIT_SALE',
      amountPaisa: 5_000_000,
      entryDate: DATE,
    });
    postEntry(db, 1, {
      partyId: b,
      entryType: 'CREDIT_SALE',
      amountPaisa: 9_000_000,
      entryDate: DATE,
    });
    // Cusp borrowed and settled up — not a debtor any more.
    postEntry(db, 1, {
      partyId: c,
      entryType: 'CREDIT_SALE',
      amountPaisa: 1_000_000,
      entryDate: DATE,
    });
    postEntry(db, 1, {
      partyId: c,
      entryType: 'REPAYMENT',
      amountPaisa: -1_000_000,
      entryDate: DATE,
    });

    const debtors = listDebtors(db);
    expect(debtors.map((d) => d.name)).toEqual(['Bilal', 'Ayesha Khan']);
    expect(debtors[0].balancePaisa).toBe(9_000_000);
    expect(debtors[0].phone).toBeNull();
    expect(debtors[1].phone).toBe('0300-1234567');

    // ...but the settled account is still visible when asked for.
    expect(listDebtors(db, true).map((d) => d.name)).toContain('Cusp');
  });

  it('reports nobody on a shop that has never given credit', () => {
    expect(listDebtors(db)).toEqual([]);
  });
});

describe('returns against a credit sale', () => {
  it('writes the debt off instead of handing over cash', () => {
    const res = sellOnCredit(10_000_000);
    expect(getBalance(db, customer)).toBe(10_000_000);

    const [line] = getReturnableLines(db, res.documentId);
    returnSale(db, 1, {
      documentId: res.documentId,
      dateISO: '2026-09-04T10:00:00.000Z',
      lines: [{ lineId: line.lineId, pieces: 1, netMg: 10_000 }],
      refundMethod: 'CREDIT',
    });

    // The customer never paid, so they get no cash — the debt just clears.
    expect(getBalance(db, customer)).toBe(0);
    const st = getStatement(db, customer);
    expect(st[1].entryType).toBe('RETURN_CREDIT');
    expect(st[1].amountPaisa).toBe(-10_000_000);
  });

  it('refuses a credit refund on a walk-in sale', () => {
    const ring = makeRing(10_000);
    const res = checkout(db, 1, {
      dateISO: DATE,
      role: 'OWNER',
      customerId: null,
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
      oldGoldLines: [],
      payments: [{ method: 'CASH', amountPaisa: 10_000_000 }],
    });

    const [line] = getReturnableLines(db, res.documentId);
    expect(() =>
      returnSale(db, 1, {
        documentId: res.documentId,
        dateISO: '2026-09-04T10:00:00.000Z',
        lines: [{ lineId: line.lineId, pieces: 1, netMg: 10_000 }],
        refundMethod: 'CREDIT',
      }),
    ).toThrow(/no account/);
  });

  it('leaves the debt alone when the refund is cash', () => {
    const res = sellOnCredit(10_000_000);
    const [line] = getReturnableLines(db, res.documentId);
    returnSale(db, 1, {
      documentId: res.documentId,
      dateISO: '2026-09-04T10:00:00.000Z',
      lines: [{ lineId: line.lineId, pieces: 1, netMg: 10_000 }],
      refundMethod: 'CASH',
    });
    // Cash went back over the counter, so the book debt still stands. The
    // shopkeeper settles it deliberately, not as a side effect.
    expect(getBalance(db, customer)).toBe(10_000_000);
  });
});

describe('the ledger is append-only', () => {
  it('refuses an update or a delete', () => {
    sellOnCredit(5_000_000);
    const id = (db.prepare('SELECT id FROM party_ledger LIMIT 1').get() as { id: number }).id;
    expect(() => db.prepare('UPDATE party_ledger SET amount_paisa=1 WHERE id=?').run(id)).toThrow(
      /append-only/,
    );
    expect(() => db.prepare('DELETE FROM party_ledger WHERE id=?').run(id)).toThrow(/append-only/);
  });

  it('refuses a zero-value entry', () => {
    expect(() =>
      postEntry(db, 1, {
        partyId: customer,
        entryType: 'ADJUSTMENT',
        amountPaisa: 0,
        entryDate: DATE,
      }),
    ).toThrow(/cannot be zero/);
  });

  it('keeps the audit chain verifiable', () => {
    sellOnCredit(5_000_000);
    recordRepayment(db, 1, {
      partyId: customer,
      amountPaisa: 2_000_000,
      method: 'CASH',
      entryDate: '2026-09-05T10:00:00.000Z',
    });
    expect(verifyAuditChain(db).ok).toBe(true);
  });
});
