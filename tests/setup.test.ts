import { describe, it, expect, beforeEach } from 'vitest';
import { openDatabase, type DB } from '../src/main/db/connection.js';
import { createItem } from '../src/main/services/itemService.js';
import { enterRate } from '../src/main/services/rateService.js';
import { setupStatus, applySetup } from '../src/main/services/setupService.js';
import { getSettings } from '../src/main/services/settingsService.js';
import { CreateItemInput } from '../src/shared/contracts/index.js';

let db: DB;

function purity(d: DB, label: string) {
  return (d.prepare('SELECT id FROM purities WHERE label=?').get(label) as { id: number }).id;
}
function gold(d: DB) {
  return (d.prepare(`SELECT id FROM metals WHERE name='Gold'`).get() as { id: number }).id;
}

function makeItem(d: DB) {
  return createItem(
    d,
    1,
    'OWNER',
    CreateItemInput.parse({
      trackingMode: 'ITEM',
      name: 'Ring',
      tagNumber: 'R1',
      productTypeId: 1,
      metalId: gold(d),
      purityId: purity(d, '22K / 916'),
      stoneTypeId: 1,
      makingTypeId: 1,
      originKind: 'IN_HOUSE',
      grossMg: 10_000,
      netMg: 10_000,
      makingMode: 'PER_GRAM',
      makingRatePaisa: 50_000,
      locationId: 1,
      openingPieces: 1,
    }),
  ).id;
}

beforeEach(() => {
  db = openDatabase({ filename: ':memory:' });
  db.prepare(
    `INSERT INTO users (id, username, display_name, pin_hash, role) VALUES (1,'owner','Owner','x','OWNER')`,
  ).run();
});

describe('setupStatus', () => {
  it('reports a blank install as unfinished, listing what is missing', () => {
    const s = setupStatus(db);
    expect(s.completed).toBe(false);
    expect(s.remaining).toContain('SHOP_DETAILS');
    expect(s.remaining).toContain('RATE');
    expect(s.remaining).toContain('STOCK');
  });

  it('stops asking for a step once it is genuinely done', () => {
    enterRate(db, 1, {
      purityId: purity(db, '22K / 916'),
      enteredValuePaisa: 2_500_000,
      enteredBasis: 'PER_GRAM',
    });
    expect(setupStatus(db).remaining).not.toContain('RATE');
  });

  it('treats a shop that already has stock as set up, whatever the name says', () => {
    // The real case this guards: an owner imports stock and posts rates before
    // getting round to the shop name. They are working — a first-run wizard
    // interrupting them is a bug, not a nudge.
    makeItem(db);
    const s = setupStatus(db);
    expect(getSettings(db).shop_name).toBe('My Jewellers');
    expect(s.completed).toBe(true);
  });

  it('still lists the outstanding steps for a working shop', () => {
    // "Completed" silences the wizard; it does not pretend the name is set, so
    // a dashboard nudge can still point at it.
    makeItem(db);
    expect(setupStatus(db).remaining).toContain('SHOP_DETAILS');
  });
});

describe('applySetup', () => {
  it('saves the shop details and marks setup done', () => {
    applySetup(db, 1, {
      shopName: 'Al-Madina Jewellers',
      shopPhone: '0300-1234567',
      shopAddress: 'Sarafa Bazaar, Lahore',
      chargesTax: true,
      taxRateBp: 300,
      activePurityIds: [purity(db, '22K / 916')],
    });

    const s = getSettings(db);
    expect(s.shop_name).toBe('Al-Madina Jewellers');
    expect(s.shop_phone).toBe('0300-1234567');
    expect(s.tax_rate_bp).toBe('300');
    expect(s.setup_completed).toBe('1');
    expect(setupStatus(db).remaining).not.toContain('SHOP_DETAILS');
  });

  it('zeroes the tax rate when the shop does not charge tax', () => {
    applySetup(db, 1, {
      shopName: 'A',
      shopPhone: '',
      shopAddress: '',
      chargesTax: false,
      // Even with a rate supplied, "no tax" must win — the checkbox is the
      // answer the owner actually gave.
      taxRateBp: 300,
      activePurityIds: [],
    });
    expect(getSettings(db).tax_rate_bp).toBe('0');
  });

  it('narrows the gold purities to what the shop deals in', () => {
    const p22 = purity(db, '22K / 916');
    applySetup(db, 1, {
      shopName: 'A',
      shopPhone: '',
      shopAddress: '',
      chargesTax: false,
      taxRateBp: 0,
      activePurityIds: [p22],
    });

    const active = db
      .prepare(
        `SELECT p.label FROM purities p JOIN metals m ON m.id = p.metal_id
         WHERE p.is_active = 1 AND m.name = 'Gold'`,
      )
      .all() as Array<{ label: string }>;
    expect(active.map((r) => r.label)).toEqual(['22K / 916']);
  });

  it('leaves silver alone — it does not follow the gold selection', () => {
    applySetup(db, 1, {
      shopName: 'A',
      shopPhone: '',
      shopAddress: '',
      chargesTax: false,
      taxRateBp: 0,
      activePurityIds: [purity(db, '22K / 916')],
    });
    const silver = db
      .prepare(`SELECT is_active FROM purities WHERE label='Silver 925'`)
      .get() as { is_active: number };
    expect(silver.is_active).toBe(1);
  });

  it('keeps every purity when the owner picks none', () => {
    applySetup(db, 1, {
      shopName: 'A',
      shopPhone: '',
      shopAddress: '',
      chargesTax: false,
      taxRateBp: 0,
      activePurityIds: [],
    });
    const n = (
      db.prepare('SELECT COUNT(*) AS n FROM purities WHERE is_active = 1').get() as { n: number }
    ).n;
    expect(n).toBeGreaterThan(1);
  });
});
