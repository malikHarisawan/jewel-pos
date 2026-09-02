import { describe, it, expect, beforeEach } from 'vitest';
import { openDatabase, type DB } from '../src/main/db/connection.js';
import { createItem } from '../src/main/services/itemService.js';
import { getSummary } from '../src/main/services/dashboardService.js';
import { CreateItemInput } from '../src/shared/contracts/index.js';
import type { z } from 'zod';

let db: DB;

function ids(d: DB) {
  const gold = (d.prepare(`SELECT id FROM metals WHERE name='Gold'`).get() as { id: number }).id;
  const silver = (d.prepare(`SELECT id FROM metals WHERE name='Silver'`).get() as { id: number }).id;
  const p22 = (d.prepare(`SELECT id FROM purities WHERE label='22K / 916'`).get() as { id: number }).id;
  const p925 = (d.prepare(`SELECT id FROM purities WHERE label='Silver 925'`).get() as { id: number }).id;
  const ring = (d.prepare(`SELECT id FROM product_types WHERE name='Ring'`).get() as { id: number }).id;
  const chain = (d.prepare(`SELECT id FROM product_types WHERE name='Chain'`).get() as { id: number }).id;
  return { gold, silver, p22, p925, ring, chain };
}

function make(d: DB, over: Partial<z.infer<typeof CreateItemInput>>) {
  const x = ids(d);
  return createItem(
    d,
    1,
    'OWNER',
    CreateItemInput.parse({
      trackingMode: 'ITEM',
      name: 'X',
      productTypeId: x.ring,
      metalId: x.gold,
      purityId: x.p22,
      stoneTypeId: 1,
      makingTypeId: 1,
      originKind: 'IN_HOUSE',
      grossMg: 10_000,
      netMg: 10_000,
      makingMode: 'PER_GRAM',
      makingRatePaisa: 0,
      locationId: 1,
      openingPieces: 1,
      ...over,
    }),
  );
}

beforeEach(() => {
  db = openDatabase({ filename: ':memory:' });
  db.prepare(
    `INSERT INTO users (id, username, display_name, pin_hash, role) VALUES (1,'owner','Owner','x','OWNER')`,
  ).run();
});

describe('dashboard summary', () => {
  it('totals in-stock items and weight, broken down by metal and category', () => {
    const x = ids(db);
    make(db, { tagNumber: 'R1', productTypeId: x.ring, metalId: x.gold, purityId: x.p22, netMg: 10_000, grossMg: 10_000 });
    make(db, { tagNumber: 'R2', productTypeId: x.ring, metalId: x.gold, purityId: x.p22, netMg: 5_000, grossMg: 5_000 });
    make(db, { tagNumber: 'C1', productTypeId: x.chain, metalId: x.silver, purityId: x.p925, netMg: 20_000, grossMg: 20_000 });

    const s = getSummary(db);
    expect(s.totalItems).toBe(3);
    expect(s.totalPieces).toBe(3);
    expect(s.totalNetMg).toBe(35_000);

    const gold = s.byMetal.find((m) => m.metalName === 'Gold')!;
    expect(gold.items).toBe(2);
    expect(gold.netMg).toBe(15_000);
    const silver = s.byMetal.find((m) => m.metalName === 'Silver')!;
    expect(silver.netMg).toBe(20_000);

    const rings = s.byCategory.find((c) => c.productTypeName === 'Ring')!;
    expect(rings.items).toBe(2);
    expect(rings.netMg).toBe(15_000);
  });

  it('excludes sold and zero-balance items, and internal RAW/SCRAP lots', () => {
    const x = ids(db);
    make(db, { tagNumber: 'R1', netMg: 10_000, grossMg: 10_000 });
    // an internal raw lot should not count
    make(db, { tagNumber: 'RAW-2', trackingMode: 'LOT', metalId: x.gold, purityId: x.p22, netMg: 50_000, grossMg: 50_000, openingPieces: 1 });
    const s = getSummary(db);
    expect(s.totalItems).toBe(1);
    expect(s.totalNetMg).toBe(10_000);
  });

  it('is empty on a fresh shop', () => {
    const s = getSummary(db);
    expect(s.totalItems).toBe(0);
    expect(s.totalNetMg).toBe(0);
    expect(s.byMetal).toEqual([]);
  });
});
