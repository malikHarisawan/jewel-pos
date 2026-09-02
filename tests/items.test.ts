import { describe, it, expect, beforeEach } from 'vitest';
import { openDatabase, type DB } from '../src/main/db/connection.js';
import { createItem, getItem, listItems, updateItem } from '../src/main/services/itemService.js';
import { CreateItemInput } from '../src/shared/contracts/index.js';
import type { z } from 'zod';

let db: DB;

function ids(d: DB) {
  const gold = (d.prepare(`SELECT id FROM metals WHERE name='Gold'`).get() as { id: number }).id;
  const p22 = (d.prepare(`SELECT id FROM purities WHERE label='22K / 916'`).get() as { id: number })
    .id;
  return { gold, p22 };
}

function baseInput(d: DB, over: Partial<z.infer<typeof CreateItemInput>> = {}) {
  const { gold, p22 } = ids(d);
  // Parse through the real schema so defaults (lessMg=0 etc.) apply, matching the router.
  return CreateItemInput.parse({
    trackingMode: 'ITEM',
    name: 'Gold Ring',
    productTypeId: 1,
    metalId: gold,
    purityId: p22,
    stoneTypeId: 1,
    makingTypeId: 1,
    originKind: 'IN_HOUSE',
    grossMg: 10_000,
    lessMg: 0,
    netMg: 10_000,
    makingMode: 'PER_GRAM',
    makingRatePaisa: 50_000,
    locationId: 1,
    ...over,
  });
}

beforeEach(() => {
  db = openDatabase({ filename: ':memory:' });
  db.prepare(
    `INSERT INTO users (id, username, display_name, pin_hash, role) VALUES (1,'owner','Owner','x','OWNER')`,
  ).run();
});

describe('item create', () => {
  it('creates an item and auto-generates a sequential tag', () => {
    const a = createItem(db, 1, 'OWNER', baseInput(db));
    const b = createItem(db, 1, 'OWNER', baseInput(db, { name: 'Second' }));
    expect(a.tagNumber).toBe('TAG-000001');
    expect(b.tagNumber).toBe('TAG-000002');
  });

  it('honors a supplied tag and rejects a duplicate', () => {
    createItem(db, 1, 'OWNER', baseInput(db, { tagNumber: 'RING-01' }));
    expect(() => createItem(db, 1, 'OWNER', baseInput(db, { tagNumber: 'RING-01' }))).toThrow();
  });

  it('rejects net != gross - less at the schema layer', () => {
    expect(() =>
      baseInput(db, { grossMg: 10_000, lessMg: 500, netMg: 10_000 }),
    ).toThrow(/netMg/);
  });

  it('posts opening stock through the ledger when openingPieces > 0', () => {
    const { id } = createItem(db, 1, 'OWNER', baseInput(db, { openingPieces: 1 }));
    const item = getItem(db, 'OWNER', id);
    expect(item.balancePieces).toBe(1);
    expect(item.balanceNetMg).toBe(10_000);
  });

  it('LOT item can open with multiple pieces and pooled weight', () => {
    const { id } = createItem(
      db,
      1,
      'OWNER',
      baseInput(db, { trackingMode: 'LOT', name: 'Silver chains', tagNumber: 'LOT-1', openingPieces: 50 }),
    );
    const item = getItem(db, 'OWNER', id);
    expect(item.balancePieces).toBe(50);
    expect(item.balanceNetMg).toBe(10_000 * 50);
  });
});

describe('cost redaction by role', () => {
  it('stores cost for an owner and returns it to owners only', () => {
    const { id } = createItem(
      db,
      1,
      'OWNER',
      baseInput(db, { cost: { labourPaidPaisa: 120_000, landedCostPaisa: 2_600_000 } }),
    );
    // Owner sees cost
    const asOwner = getItem(db, 'OWNER', id);
    expect(asOwner.cost?.labourPaidPaisa).toBe(120_000);
    // Salesman gets null cost — structural redaction
    const asSalesman = getItem(db, 'SALESMAN', id);
    expect(asSalesman.cost).toBeNull();
  });

  it('ignores cost supplied by a non-owner creator', () => {
    const { id } = createItem(
      db,
      1,
      'SALESMAN',
      baseInput(db, { cost: { labourPaidPaisa: 999 } }),
    );
    // even the owner sees no cost row, because a salesman can't write it
    expect(getItem(db, 'OWNER', id).cost).toBeNull();
  });
});

describe('item list & update', () => {
  it('searches by name and tag, and filters by metal', () => {
    createItem(db, 1, 'OWNER', baseInput(db, { name: 'Bridal Set', tagNumber: 'BS-1' }));
    createItem(db, 1, 'OWNER', baseInput(db, { name: 'Daily Ring', tagNumber: 'DR-1' }));
    expect(listItems(db, 'OWNER', { search: 'Bridal', limit: 100 })).toHaveLength(1);
    expect(listItems(db, 'OWNER', { search: 'DR-1', limit: 100 })).toHaveLength(1);
    const { gold } = ids(db);
    expect(listItems(db, 'OWNER', { metalId: gold, limit: 100 })).toHaveLength(2);
  });

  it('updates fields and keeps the net = gross - less invariant', () => {
    const { id } = createItem(db, 1, 'OWNER', baseInput(db));
    const updated = updateItem(db, 1, 'OWNER', {
      id,
      name: 'Renamed Ring',
      productTypeId: 1,
      metalId: ids(db).gold,
      purityId: ids(db).p22,
      stoneTypeId: 1,
      makingTypeId: 1,
      originKind: 'IN_HOUSE',
      grossMg: 12_000,
      lessMg: 500,
      netMg: 11_500,
      wastageBp: 0,
      makingMode: 'PER_GRAM',
      makingRatePaisa: 50_000,
      hallmarkChargePaisa: 0,
      locationId: 1,
    });
    expect(updated.name).toBe('Renamed Ring');
    expect(updated.netMg).toBe(11_500);
  });
});
