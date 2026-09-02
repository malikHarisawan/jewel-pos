import { describe, it, expect, beforeEach } from 'vitest';
import { openDatabase, type DB } from '../src/main/db/connection.js';
import { createItem } from '../src/main/services/itemService.js';
import {
  purchaseIn,
  adjust,
  reverseMovement,
  listMovements,
  listBalances,
} from '../src/main/services/stockService.js';
import { CreateItemInput } from '../src/shared/contracts/index.js';
import type { z } from 'zod';

let db: DB;

function ids(d: DB) {
  const gold = (d.prepare(`SELECT id FROM metals WHERE name='Gold'`).get() as { id: number }).id;
  const p22 = (d.prepare(`SELECT id FROM purities WHERE label='22K / 916'`).get() as { id: number })
    .id;
  return { gold, p22 };
}

function makeItem(d: DB, over: Partial<z.infer<typeof CreateItemInput>> = {}) {
  const { gold, p22 } = ids(d);
  const input = CreateItemInput.parse({
    trackingMode: 'LOT',
    name: 'Silver Chains',
    productTypeId: 5,
    metalId: gold,
    purityId: p22,
    stoneTypeId: 1,
    makingTypeId: 1,
    originKind: 'IN_HOUSE',
    grossMg: 1000,
    netMg: 1000,
    makingMode: 'PER_GRAM',
    makingRatePaisa: 0,
    locationId: 1,
    openingPieces: 0,
    ...over,
  });
  return createItem(db, 1, 'OWNER', input).id;
}

beforeEach(() => {
  db = openDatabase({ filename: ':memory:' });
  db.prepare(
    `INSERT INTO users (id, username, display_name, pin_hash, role) VALUES (1,'owner','Owner','x','OWNER')`,
  ).run();
});

describe('purchase in', () => {
  it('adds pieces and weight to the balance', () => {
    const item = makeItem(db, { tagNumber: 'LOT-A' });
    const r = purchaseIn(db, 1, { itemId: item, pieces: 100, grossMg: 200_000, netMg: 200_000 });
    expect(r.balance.pieces).toBe(100);
    expect(r.balance.netMg).toBe(200_000);
    expect(r.movementId).toBeGreaterThan(0);
  });
});

describe('adjustment', () => {
  it('applies a signed correction with a reason', () => {
    const item = makeItem(db, { tagNumber: 'LOT-B' });
    purchaseIn(db, 1, { itemId: item, pieces: 10, grossMg: 5_000, netMg: 5_000 });
    const r = adjust(db, 1, {
      itemId: item,
      piecesDelta: 0,
      grossMgDelta: -50,
      netMgDelta: -50,
      reasonCode: 'POLISH_LOSS',
    });
    expect(r.balance.netMg).toBe(4_950);
  });

  it('cannot drive the balance negative', () => {
    const item = makeItem(db, { tagNumber: 'LOT-C' });
    purchaseIn(db, 1, { itemId: item, pieces: 1, grossMg: 100, netMg: 100 });
    expect(() =>
      adjust(db, 1, {
        itemId: item,
        piecesDelta: 0,
        grossMgDelta: -500,
        netMgDelta: -500,
        reasonCode: 'WEIGHING_ERROR',
      }),
    ).toThrow(/insufficient stock/);
  });
});

describe('reversal', () => {
  it('reverses a movement back to the prior balance', () => {
    const item = makeItem(db, { tagNumber: 'LOT-D' });
    const p = purchaseIn(db, 1, { itemId: item, pieces: 5, grossMg: 3_000, netMg: 3_000 });
    const r = reverseMovement(db, 1, { movementId: p.movementId, reasonCode: 'DATA_ENTRY_ERROR' });
    expect(r.balance).toEqual({ pieces: 0, grossMg: 0, netMg: 0 });
  });
});

describe('read queries', () => {
  it('lists movements with joined item and user names, newest first', () => {
    const item = makeItem(db, { tagNumber: 'LOT-E', name: 'Gold Bar' });
    purchaseIn(db, 1, { itemId: item, pieces: 1, grossMg: 100_000, netMg: 100_000 });
    adjust(db, 1, {
      itemId: item,
      piecesDelta: 0,
      grossMgDelta: -10,
      netMgDelta: -10,
      reasonCode: 'WEIGHING_ERROR',
    });
    const rows = listMovements(db, { itemId: item, limit: 100 });
    expect(rows).toHaveLength(2);
    expect(rows[0].movementType).toBe('ADJUSTMENT'); // newest first
    expect(rows[0].createdByName).toBe('Owner');
    expect(rows[0].itemName).toBe('Gold Bar');
    expect(rows[0].reasonCode).toBe('WEIGHING_ERROR');
  });

  it('lists balances and filters to non-zero', () => {
    const a = makeItem(db, { tagNumber: 'LOT-F', name: 'Has Stock' });
    makeItem(db, { tagNumber: 'LOT-G', name: 'Empty' });
    purchaseIn(db, 1, { itemId: a, pieces: 3, grossMg: 900, netMg: 900 });
    const all = listBalances(db, { nonZeroOnly: false, limit: 100 });
    expect(all).toHaveLength(2);
    const nonZero = listBalances(db, { nonZeroOnly: true, limit: 100 });
    expect(nonZero).toHaveLength(1);
    expect(nonZero[0].name).toBe('Has Stock');
    expect(nonZero[0].netMg).toBe(900);
  });
});
