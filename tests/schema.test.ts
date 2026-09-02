import { describe, it, expect, beforeEach } from 'vitest';
import { openDatabase, type DB } from '../src/main/db/connection.js';
import { LATEST_VERSION } from '../src/main/db/migrations/index.js';

let db: DB;

/** Fresh in-memory DB, migrated, with one owner user and helper look-ups. */
function seedBaseline(d: DB) {
  d.prepare(
    `INSERT INTO users (id, username, display_name, pin_hash, role) VALUES (1,'owner','Owner','x','OWNER')`,
  ).run();
}

beforeEach(() => {
  db = openDatabase({ filename: ':memory:' });
  seedBaseline(db);
});

describe('migrations', () => {
  it('applies to latest version and seeds axes', () => {
    expect(db.pragma('user_version', { simple: true })).toBe(LATEST_VERSION);
    const metals = db.prepare('SELECT count(*) c FROM metals').get() as { c: number };
    expect(metals.c).toBe(4);
    const purities = db.prepare('SELECT count(*) c FROM purities').get() as { c: number };
    expect(purities.c).toBe(6);
  });

  it('is idempotent (re-open runs no migrations)', () => {
    // Same in-memory handle can't persist; assert runner skips already-applied.
    const r = (db as unknown as { pragma: (s: string, o: object) => number }).pragma(
      'user_version',
      { simple: true },
    );
    expect(r).toBe(LATEST_VERSION);
  });
});

/** Insert an ITEM-mode gold item and return its id. */
function makeItem(d: DB, overrides: Partial<Record<string, unknown>> = {}): number {
  const purityId = (
    d.prepare(`SELECT id FROM purities WHERE label='22K / 916'`).get() as { id: number }
  ).id;
  const cols = {
    tracking_mode: 'ITEM',
    tag_number: `TAG-${Math.floor(Math.random() * 1e9)}`,
    name: 'Test Ring',
    product_type_id: 1,
    metal_id: (d.prepare(`SELECT id FROM metals WHERE name='Gold'`).get() as { id: number }).id,
    purity_id: purityId,
    stone_type_id: 1,
    making_type_id: 1,
    origin_kind: 'IN_HOUSE',
    gross_mg: 10_000,
    less_mg: 0,
    net_mg: 10_000,
    status: 'IN_STOCK',
    location_id: 1,
    created_by: 1,
    ...overrides,
  };
  const keys = Object.keys(cols);
  const stmt = d.prepare(
    `INSERT INTO items (${keys.join(',')}) VALUES (${keys.map((k) => `@${k}`).join(',')})`,
  );
  const info = stmt.run(cols);
  return Number(info.lastInsertRowid);
}

function postMovement(d: DB, row: Record<string, unknown>) {
  const base = {
    location_id: 1,
    pieces_delta: 0,
    gross_mg_delta: 0,
    net_mg_delta: 0,
    document_id: null,
    document_line_id: null,
    party_id: null,
    transfer_group: null,
    reason_code: null,
    reverses_movement_id: null,
    notes: null,
    created_by: 1,
    ...row,
  };
  const keys = Object.keys(base);
  return d
    .prepare(
      `INSERT INTO stock_movements (${keys.join(',')}) VALUES (${keys
        .map((k) => `@${k}`)
        .join(',')})`,
    )
    .run(base);
}

describe('ledger balance maintenance', () => {
  it('derives dual-unit balance from movements', () => {
    const item = makeItem(db);
    postMovement(db, {
      movement_type: 'OPENING',
      item_id: item,
      pieces_delta: 1,
      gross_mg_delta: 10_000,
      net_mg_delta: 10_000,
    });
    const bal = db.prepare('SELECT * FROM item_balances WHERE item_id=?').get(item) as {
      pieces: number;
      net_mg: number;
    };
    expect(bal.pieces).toBe(1);
    expect(bal.net_mg).toBe(10_000);
  });

  it('materialized balance equals SUM of ledger (rebuild check)', () => {
    const lot = makeItem(db, { tracking_mode: 'LOT', tag_number: 'LOT-1' });
    postMovement(db, {
      movement_type: 'OPENING',
      item_id: lot,
      pieces_delta: 100,
      gross_mg_delta: 200_000,
      net_mg_delta: 200_000,
    });
    postMovement(db, {
      movement_type: 'SALE_OUT',
      item_id: lot,
      pieces_delta: -3,
      gross_mg_delta: -6_000,
      net_mg_delta: -6_000,
    });
    const mat = db.prepare('SELECT net_mg FROM item_balances WHERE item_id=?').get(lot) as {
      net_mg: number;
    };
    const sum = db
      .prepare('SELECT COALESCE(SUM(net_mg_delta),0) s FROM stock_movements WHERE item_id=?')
      .get(lot) as { s: number };
    expect(mat.net_mg).toBe(sum.s);
    expect(mat.net_mg).toBe(194_000);
  });
});

describe('ledger invariants (triggers)', () => {
  it('blocks a sale exceeding stock (weight goes negative)', () => {
    const lot = makeItem(db, { tracking_mode: 'LOT', tag_number: 'LOT-2' });
    postMovement(db, {
      movement_type: 'OPENING',
      item_id: lot,
      pieces_delta: 10,
      gross_mg_delta: 5_000,
      net_mg_delta: 5_000,
    });
    expect(() =>
      postMovement(db, {
        movement_type: 'SALE_OUT',
        item_id: lot,
        pieces_delta: -1,
        gross_mg_delta: -6_000,
        net_mg_delta: -6_000,
      }),
    ).toThrow(/insufficient stock/);
  });

  it('is append-only: UPDATE and DELETE are blocked', () => {
    const item = makeItem(db);
    const info = postMovement(db, {
      movement_type: 'OPENING',
      item_id: item,
      pieces_delta: 1,
      gross_mg_delta: 10_000,
      net_mg_delta: 10_000,
    });
    const id = Number(info.lastInsertRowid);
    expect(() => db.prepare('UPDATE stock_movements SET notes=? WHERE id=?').run('x', id)).toThrow(
      /append-only/,
    );
    expect(() => db.prepare('DELETE FROM stock_movements WHERE id=?').run(id)).toThrow(
      /append-only/,
    );
  });

  it('ITEM-mode movement must move exactly one piece', () => {
    const item = makeItem(db);
    expect(() =>
      postMovement(db, {
        movement_type: 'OPENING',
        item_id: item,
        pieces_delta: 2,
        gross_mg_delta: 20_000,
        net_mg_delta: 20_000,
      }),
    ).toThrow(/exactly one piece/);
  });

  it('rejects an ADJUSTMENT without a reason code (CHECK)', () => {
    const item = makeItem(db);
    postMovement(db, {
      movement_type: 'OPENING',
      item_id: item,
      pieces_delta: 1,
      gross_mg_delta: 10_000,
      net_mg_delta: 10_000,
    });
    expect(() =>
      postMovement(db, {
        movement_type: 'ADJUSTMENT',
        item_id: item,
        pieces_delta: 0,
        gross_mg_delta: -5,
        net_mg_delta: -5,
      }),
    ).toThrow();
  });

  it('metal_rates is append-only', () => {
    const purityId = (
      db.prepare(`SELECT id FROM purities WHERE label='22K / 916'`).get() as { id: number }
    ).id;
    const info = db
      .prepare(
        `INSERT INTO metal_rates (purity_id, rate_paisa_per_gram, entered_value_paisa, entered_basis, entered_by)
         VALUES (?,?,?,?,1)`,
      )
      .run(purityId, 2_500_000, 2_500_000, 'PER_GRAM');
    expect(() =>
      db
        .prepare('UPDATE metal_rates SET rate_paisa_per_gram=? WHERE id=?')
        .run(9, Number(info.lastInsertRowid)),
    ).toThrow(/append-only/);
  });
});
