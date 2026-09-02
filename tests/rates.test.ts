import { describe, it, expect, beforeEach } from 'vitest';
import { openDatabase, type DB } from '../src/main/db/connection.js';
import { createItem } from '../src/main/services/itemService.js';
import { enterRate, latestRates, rateHistory, quoteItems } from '../src/main/services/rateService.js';
import { CreateItemInput } from '../src/shared/contracts/index.js';
import type { z } from 'zod';

let db: DB;

function purity(d: DB, label: string) {
  return (d.prepare('SELECT id FROM purities WHERE label=?').get(label) as { id: number }).id;
}
function gold(d: DB) {
  return (d.prepare(`SELECT id FROM metals WHERE name='Gold'`).get() as { id: number }).id;
}

function makeItem(d: DB, over: Partial<z.infer<typeof CreateItemInput>>) {
  const input = CreateItemInput.parse({
    trackingMode: 'ITEM',
    name: 'Ring',
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
  // FBR-style tax config for quoting
  db.prepare(`UPDATE app_settings SET value='300' WHERE key='tax_rate_bp'`).run();
  db.prepare(`UPDATE app_settings SET value='TOTAL_MINUS_METAL' WHERE key='tax_base'`).run();
});

describe('enter rate + latest', () => {
  it('normalises per-tola entry to paisa/gram and reports latest', () => {
    const p22 = purity(db, '22K / 916');
    // Rs 291,600 per tola (11.664 g) -> Rs 25,000/g = 2,500,000 paisa/g
    enterRate(db, 1, { purityId: p22, enteredValuePaisa: 29_160_000, enteredBasis: 'PER_TOLA' });
    const latest = latestRates(db).find((r) => r.purityId === p22)!;
    expect(latest.ratePaisaPerGram).toBe(2_500_000);
  });

  it('latest reflects the newest entry (append-only correction)', () => {
    const p22 = purity(db, '22K / 916');
    enterRate(db, 1, { purityId: p22, enteredValuePaisa: 2_400_000, enteredBasis: 'PER_GRAM' });
    enterRate(db, 1, { purityId: p22, enteredValuePaisa: 2_600_000, enteredBasis: 'PER_GRAM' });
    const latest = latestRates(db).find((r) => r.purityId === p22)!;
    expect(latest.ratePaisaPerGram).toBe(2_600_000);
    expect(rateHistory(db, { purityId: p22, limit: 10 })).toHaveLength(2);
  });

  it('purities with no rate come back null', () => {
    const board = latestRates(db);
    expect(board.every((r) => r.ratePaisaPerGram === null)).toBe(true);
    expect(board.length).toBeGreaterThanOrEqual(6);
  });
});

describe('quoteItems', () => {
  it('prices an item at the current rate matching the engine', () => {
    const p22 = purity(db, '22K / 916');
    enterRate(db, 1, { purityId: p22, enteredValuePaisa: 2_500_000, enteredBasis: 'PER_GRAM' });
    const item = makeItem(db, { tagNumber: 'R1' }); // 10g, making 500/g
    const [q] = quoteItems(db, { itemIds: [item] });
    expect(q.hasRate).toBe(true);
    // metal 25,000,000 + making 500,000 + FBR tax 3% of making (15,000)
    expect(q.metalValuePaisa).toBe(25_000_000);
    expect(q.makingValuePaisa).toBe(500_000);
    expect(q.taxPaisa).toBe(15_000);
    expect(q.totalPaisa).toBe(25_515_000);
  });

  it('flags items with no rate for their purity', () => {
    const item = makeItem(db, { tagNumber: 'R2' }); // no rate entered
    const [q] = quoteItems(db, { itemIds: [item] });
    expect(q.hasRate).toBe(false);
    expect(q.totalPaisa).toBe(0);
  });
});
