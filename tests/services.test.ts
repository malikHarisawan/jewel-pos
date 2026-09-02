import { describe, it, expect, beforeEach } from 'vitest';
import { openDatabase, type DB } from '../src/main/db/connection.js';
import { withAudit, verifyAuditChain } from '../src/main/db/audit.js';
import { insertMovement, getBalance, reverse } from '../src/main/services/ledgerService.js';
import { finalizeInvoice } from '../src/main/services/invoiceService.js';

let db: DB;

function ids(d: DB) {
  const gold = (d.prepare(`SELECT id FROM metals WHERE name='Gold'`).get() as { id: number }).id;
  const p22 = (d.prepare(`SELECT id FROM purities WHERE label='22K / 916'`).get() as { id: number })
    .id;
  return { gold, p22 };
}

function seedRate(d: DB, purityId: number, paisaPerGram: number): number {
  const info = d
    .prepare(
      `INSERT INTO metal_rates (purity_id, rate_paisa_per_gram, entered_value_paisa, entered_basis, entered_by)
       VALUES (?,?,?,'PER_GRAM',1)`,
    )
    .run(purityId, paisaPerGram, paisaPerGram);
  return Number(info.lastInsertRowid);
}

function makeItem(d: DB, tracking: 'ITEM' | 'LOT', tag: string, netMg: number): number {
  const { gold, p22 } = ids(d);
  const info = d
    .prepare(
      `INSERT INTO items
        (tracking_mode, tag_number, name, product_type_id, metal_id, purity_id, stone_type_id,
         making_type_id, origin_kind, gross_mg, less_mg, net_mg, status, location_id, created_by)
       VALUES (?,?,?,1,?,?,1,1,'IN_HOUSE',?,0,?, 'IN_STOCK',1,1)`,
    )
    .run(tracking, tag, `Item ${tag}`, gold, p22, netMg, netMg);
  return Number(info.lastInsertRowid);
}

beforeEach(() => {
  db = openDatabase({ filename: ':memory:' });
  db.prepare(
    `INSERT INTO users (id, username, display_name, pin_hash, role) VALUES (1,'owner','Owner','x','OWNER')`,
  ).run();
});

describe('audit hash-chain', () => {
  it('verifies an intact chain and detects tampering', () => {
    withAudit(db, 1, (ctx) => {
      ctx.record({ table: 'items', rowPk: 1, action: 'INSERT', changes: { a: 1 } });
      ctx.record({ table: 'items', rowPk: 1, action: 'UPDATE', changes: { a: 2 } });
    });
    expect(verifyAuditChain(db).ok).toBe(true);

    // Tamper: rewrite changes_json directly (bypassing the app layer).
    // audit_log blocks UPDATE via trigger, so simulate a raw attacker by
    // dropping the trigger first — proving verify catches the edit.
    db.exec('DROP TRIGGER trg_audit_no_update');
    db.prepare('UPDATE audit_log SET changes_json=? WHERE id=1').run('{"a":999}');
    const v = verifyAuditChain(db);
    expect(v.ok).toBe(false);
    expect(v.brokenAtId).toBe(1);
  });
});

describe('ledger reversal', () => {
  it('a reversal returns the balance to zero', () => {
    const item = makeItem(db, 'ITEM', 'R1', 10_000);
    const mv = insertMovement(db, 1, {
      movementType: 'OPENING',
      itemId: item,
      locationId: 1,
      piecesDelta: 1,
      grossMgDelta: 10_000,
      netMgDelta: 10_000,
    });
    expect(getBalance(db, item).netMg).toBe(10_000);
    reverse(db, 1, mv, 'DATA_ENTRY_ERROR');
    expect(getBalance(db, item)).toEqual({ pieces: 0, grossMg: 0, netMg: 0 });
  });
});

describe('invoice finalize', () => {
  function openDraft(d: DB): number {
    const info = d
      .prepare(
        `INSERT INTO documents (doc_type, status, doc_date, created_by)
         VALUES ('SALE_INVOICE','DRAFT','2026-07-27',1)`,
      )
      .run();
    return Number(info.lastInsertRowid);
  }
  function lockRate(d: DB, docId: number, purityId: number, rateId: number) {
    d.prepare(
      `INSERT INTO document_rate_locks (document_id, purity_id, metal_rate_id) VALUES (?,?,?)`,
    ).run(docId, purityId, rateId);
  }

  it('rolls back everything when payments do not cover the total', () => {
    const { p22 } = ids(db);
    const rateId = seedRate(db, p22, 2_500_000);
    const ring = makeItem(db, 'ITEM', 'RING-2', 10_000);
    insertMovement(db, 1, {
      movementType: 'OPENING',
      itemId: ring,
      locationId: 1,
      piecesDelta: 1,
      grossMgDelta: 10_000,
      netMgDelta: 10_000,
    });
    const docId = openDraft(db);
    lockRate(db, docId, p22, rateId);

    expect(() =>
      finalizeInvoice(db, 1, {
        documentId: docId,
        saleLines: [
          {
            itemId: ring,
            pieces: 1,
            netMg: 10_000,
            grossMg: 10_000,
            purityId: p22,
            wastageBp: 0,
            making: { mode: 'PER_GRAM', ratePaisa: 50_000 },
            stones: [],
            hallmarkChargePaisa: 0,
            discountPaisa: 0,
            description: 'Gold ring',
          },
        ],
        oldGoldLines: [],
        payments: [{ method: 'CASH', amountPaisa: 1 }], // wrong
        tax: { rateBp: 0, base: 'TOTAL' },
        roundTo: 100,
        scrapLocationId: 1,
      }),
    ).toThrow(/do not cover/);

    // Atomicity: item still in stock, no lines, no movements from the sale, doc still DRAFT.
    expect(getBalance(db, ring).netMg).toBe(10_000);
    const status = (db.prepare('SELECT status FROM documents WHERE id=?').get(docId) as {
      status: string;
    }).status;
    expect(status).toBe('DRAFT');
    const lines = db.prepare('SELECT count(*) c FROM document_lines WHERE document_id=?').get(docId) as {
      c: number;
    };
    expect(lines.c).toBe(0);
  });

  it('finalizes with correct total and decrements stock', () => {
    const { p22 } = ids(db);
    const rateId = seedRate(db, p22, 2_500_000);
    const ring = makeItem(db, 'ITEM', 'RING-3', 10_000);
    insertMovement(db, 1, {
      movementType: 'OPENING',
      itemId: ring,
      locationId: 1,
      piecesDelta: 1,
      grossMgDelta: 10_000,
      netMgDelta: 10_000,
    });
    const docId = openDraft(db);
    lockRate(db, docId, p22, rateId);

    // metal 25,000,000 + making 500,000 + tax 3% of 500,000 = 15,000 => 25,515,000
    const res = finalizeInvoice(db, 1, {
      documentId: docId,
      saleLines: [
        {
          itemId: ring,
          pieces: 1,
          netMg: 10_000,
          grossMg: 10_000,
          purityId: p22,
          wastageBp: 0,
          making: { mode: 'PER_GRAM', ratePaisa: 50_000 },
          stones: [],
          hallmarkChargePaisa: 0,
          discountPaisa: 0,
          description: 'Gold ring',
        },
      ],
      oldGoldLines: [],
      payments: [
        { method: 'CASH', amountPaisa: 20_000_000 },
        { method: 'CARD', amountPaisa: 5_515_000 },
      ],
      tax: { rateBp: 300, base: 'TOTAL_MINUS_METAL' },
      roundTo: 100,
      scrapLocationId: 1,
    });

    expect(res.grandTotalPaisa).toBe(25_515_000);
    expect(res.docNumber).toBe('INV-2026-0001');
    // ITEM sold out
    expect(getBalance(db, ring).pieces).toBe(0);
    const item = db.prepare('SELECT status FROM items WHERE id=?').get(ring) as { status: string };
    expect(item.status).toBe('SOLD');
    expect(verifyAuditChain(db).ok).toBe(true);
  });

  it('handles old-gold exchange as a scrap intake and negative credit', () => {
    const { p22 } = ids(db);
    const rateId = seedRate(db, p22, 2_500_000);
    const ring = makeItem(db, 'ITEM', 'RING-4', 20_000); // 20g
    insertMovement(db, 1, {
      movementType: 'OPENING',
      itemId: ring,
      locationId: 1,
      piecesDelta: 1,
      grossMgDelta: 20_000,
      netMgDelta: 20_000,
    });
    const docId = openDraft(db);
    lockRate(db, docId, p22, rateId);

    // sale: metal 50,000,000 + making 1,000,000 + tax 30,000 = 51,030,000
    // old gold 10g @91.6% @25,000 = -22,900,000
    // grand = 28,130,000
    const res = finalizeInvoice(db, 1, {
      documentId: docId,
      saleLines: [
        {
          itemId: ring,
          pieces: 1,
          netMg: 20_000,
          grossMg: 20_000,
          purityId: p22,
          wastageBp: 0,
          making: { mode: 'PER_GRAM', ratePaisa: 50_000 },
          stones: [],
          hallmarkChargePaisa: 0,
          discountPaisa: 0,
          description: 'Gold ring 20g',
        },
      ],
      oldGoldLines: [
        { purityId: p22, netMg: 10_000, grossMg: 10_000, touchBp: 9160, description: 'Old chain' },
      ],
      payments: [{ method: 'CASH', amountPaisa: 28_130_000 }],
      tax: { rateBp: 300, base: 'TOTAL_MINUS_METAL' },
      roundTo: 100,
      scrapLocationId: 1,
    });

    expect(res.grandTotalPaisa).toBe(28_130_000);
    // scrap LOT item created and carries 10g
    const scrap = db.prepare(`SELECT id FROM items WHERE tag_number=?`).get(`SCRAP-${p22}`) as {
      id: number;
    };
    expect(getBalance(db, scrap.id).netMg).toBe(10_000);
    const exchangeVal = (
      db.prepare('SELECT exchange_value_paisa FROM documents WHERE id=?').get(docId) as {
        exchange_value_paisa: number;
      }
    ).exchange_value_paisa;
    expect(exchangeVal).toBe(-22_900_000);
  });
});
