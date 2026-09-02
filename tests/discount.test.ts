/**
 * Discount authority. The POS sends a signed `saleAdjustmentPaisa` to set the
 * final price; without a ceiling any cashier could zero out a bill. These tests
 * pin the ceiling to the CALLER'S ROLE and, importantly, prove the rounding
 * tolerance in checkout cannot be used to slip past it.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { openDatabase, type DB } from '../src/main/db/connection.js';
import { createItem } from '../src/main/services/itemService.js';
import { enterRate } from '../src/main/services/rateService.js';
import { checkout, assertDiscountAllowed } from '../src/main/services/invoiceService.js';
import { CreateItemInput } from '../src/shared/contracts/index.js';
import type { Role } from '../src/shared/domain/enums.js';

let db: DB;

function purity(d: DB, label: string) {
  return (d.prepare('SELECT id FROM purities WHERE label=?').get(label) as { id: number }).id;
}
function gold(d: DB) {
  return (d.prepare(`SELECT id FROM metals WHERE name='Gold'`).get() as { id: number }).id;
}

/** A plain 10g ring with no making charge, so the total is easy to reason about. */
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
    makingRatePaisa: 0,
    locationId: 1,
    openingPieces: 1,
  });
  return createItem(d, 1, 'OWNER', input).id;
}

const ISO = '2026-09-02T10:00:00.000Z';

/** Sell one 10g ring at Rs 10,000/g => a clean Rs 1,00,000 (10,000,000 paisa). */
function sellRing(role: Role, adjustmentPaisa: number, paidPaisa?: number) {
  const p22 = purity(db, '22K / 916');
  const ring = makeRing(db, `R-${Math.abs(adjustmentPaisa)}-${role}`, 10_000);
  const total = 10_000_000; // 10g * 1,000,000 paisa/g
  const pay = paidPaisa ?? total + adjustmentPaisa;
  return checkout(db, 1, {
    dateISO: ISO,
    role,
    saleLines: [
      {
        itemId: ring,
        pieces: 1,
        netMg: 10_000,
        grossMg: 10_000,
        purityId: p22,
        wastageBp: 0,
        making: { mode: 'PER_GRAM', ratePaisa: 0 },
        stones: [],
        hallmarkChargePaisa: 0,
        discountPaisa: 0,
        description: 'Ring',
      },
    ],
    oldGoldLines: [],
    payments: [{ method: 'CASH', amountPaisa: pay }],
    saleAdjustmentPaisa: adjustmentPaisa,
  });
}

beforeEach(() => {
  db = openDatabase({ filename: ':memory:' });
  db.prepare(
    `INSERT INTO users (id, username, display_name, pin_hash, role) VALUES (1,'owner','Owner','x','OWNER')`,
  ).run();
  // No tax, no rounding — isolate the discount rule from every other effect.
  db.prepare(`UPDATE app_settings SET value='0' WHERE key='tax_rate_bp'`).run();
  db.prepare(`UPDATE app_settings SET value='1' WHERE key='invoice_round_to'`).run();
  enterRate(db, 1, {
    purityId: purity(db, '22K / 916'),
    enteredValuePaisa: 1_000_000, // Rs 10,000 per gram
    enteredBasis: 'PER_GRAM',
  });
});

describe('discount ceiling by role', () => {
  it('lets a salesman discount up to the 5% default', () => {
    // 5% of Rs 1,00,000 = Rs 5,000 exactly — the boundary must be allowed.
    const res = sellRing('SALESMAN', -500_000);
    expect(res.grandTotalPaisa).toBe(9_500_000);
  });

  it('refuses a salesman discount one paisa past the limit', () => {
    expect(() => sellRing('SALESMAN', -500_001)).toThrow(/exceeds the 5% limit/);
  });

  it('allows a manager the same discount a salesman is refused', () => {
    const res = sellRing('MANAGER', -1_500_000); // 15%, under the 20% manager cap
    expect(res.grandTotalPaisa).toBe(8_500_000);
  });

  it('refuses even an owner past the manager ceiling', () => {
    // The cap is a fat-finger guard, not only an anti-theft rule.
    expect(() => sellRing('OWNER', -2_000_001)).toThrow(/exceeds the 20% limit/);
  });

  it('never caps a surcharge — charging more is not a leak', () => {
    const res = sellRing('SALESMAN', +5_000_000); // +50%
    expect(res.grandTotalPaisa).toBe(15_000_000);
  });

  it('refuses a discount larger than the sale itself', () => {
    expect(() => sellRing('OWNER', -10_000_001)).toThrow(/cannot exceed the sale total/);
  });

  it('honours a shop-configured ceiling instead of the default', () => {
    db.prepare(`UPDATE app_settings SET value='10' WHERE key='max_discount_pct_salesman'`).run();
    const res = sellRing('SALESMAN', -1_000_000); // 10% now allowed
    expect(res.grandTotalPaisa).toBe(9_000_000);
  });
});

describe('the rounding tolerance is not a bypass', () => {
  it('re-checks the ACTUAL charge, so paying less than the adjustment cannot widen the discount', () => {
    // invoice_round_to = 100 gives checkout a Rs 1 tolerance window. A client
    // that requests a legal 5% discount but then pays Rs 1 less would land at
    // 5.001% — above the cap. The post-tolerance re-check must catch it.
    db.prepare(`UPDATE app_settings SET value='100' WHERE key='invoice_round_to'`).run();
    expect(() =>
      sellRing('SALESMAN', -500_000, 9_499_900), // asks for 5%, actually pays Rs 1 less
    ).toThrow(/exceeds the 5% limit/);
  });
});

describe('assertDiscountAllowed unit rules', () => {
  it('is a no-op for a zero adjustment', () => {
    expect(() => assertDiscountAllowed(db, 'SALESMAN', 10_000_000, 0)).not.toThrow();
  });

  it('refuses to discount a non-positive total rather than dividing by zero', () => {
    // A pure old-gold exchange nets out to zero or below; there is no base to
    // take a percentage of.
    expect(() => assertDiscountAllowed(db, 'OWNER', 0, -1)).toThrow(/no positive total/);
    expect(() => assertDiscountAllowed(db, 'OWNER', -5_000, -1)).toThrow(/no positive total/);
  });

  it('falls back to the safe default when the setting is missing or garbled', () => {
    db.prepare(`UPDATE app_settings SET value='not-a-number' WHERE key='max_discount_pct_salesman'`).run();
    // Must fall back to 5%, NOT to "unlimited".
    expect(() => assertDiscountAllowed(db, 'SALESMAN', 10_000_000, -600_000)).toThrow(/5% limit/);
    expect(() => assertDiscountAllowed(db, 'SALESMAN', 10_000_000, -500_000)).not.toThrow();
  });
});
