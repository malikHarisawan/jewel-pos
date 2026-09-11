/**
 * A messy sheet of the kind a shop actually hands over: awkward headers, mixed
 * units, blank cells, a stray blank row, a couple of genuine mistakes.
 *
 * The unit tests in import.test.ts each pin one rule. This one checks the rules
 * hold together on a whole realistic file — that the good rows survive the bad
 * ones, and that the bad ones are described well enough to fix.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as XLSX from 'xlsx';
import { openDatabase, type DB } from '../src/main/db/connection.js';
import { analyseItemSheet, commitItemImport } from '../src/main/import/itemImport.js';

let db: DB;
let dir: string;

beforeEach(() => {
  db = openDatabase({ filename: ':memory:' });
  db.prepare(
    `INSERT INTO users (id, username, display_name, pin_hash, role) VALUES (1,'owner','Owner','x','OWNER')`,
  ).run();
  dir = mkdtempSync(join(tmpdir(), 'jp-real-'));
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

const SHEET = [
  // Headers as a shop writes them: abbreviations, units in brackets, slashes.
  ['Tag No.', 'Particulars', 'Category', 'Purity', 'Gross Wt (gms)', 'Net Wt (gms)', 'Making /gm', 'Wastage %', 'Qty', 'Remarks'],
  // Ordinary tagged pieces.
  ['R-101', 'Ladies Ring Zircon', 'Ring', '22K', '4.250', '3.900', '1,200', '8', '1', 'showcase 2'],
  ['N-204', 'Bridal Set Heavy', 'Necklace / Set', '21K', '85.500', '78.250', '1,500', '10', '1', ''],
  // Blank row in the middle, as spreadsheets always have.
  ['', '', '', '', '', '', '', '', '', ''],
  // No tag — the importer must allocate one.
  ['', 'Gents Chain', 'Chain', '22K', '32.000', '32.000', '900', '5', '1', ''],
  // A lot: many pieces of one description.
  ['B-500', 'Silver Payal Pairs', 'Payal', 'Silver 925', '45.000', '45.000', '150', '0', '6', 'bulk'],
  // Mistake 1: net heavier than gross.
  ['R-102', 'Bad Weights Ring', 'Ring', '22K', '5.000', '6.000', '1000', '5', '1', ''],
  // Mistake 2: a category that does not exist in the app.
  ['X-1', 'Mystery Object', 'Spaceship', '22K', '10.000', '10.000', '500', '0', '1', ''],
  // Mistake 3: purity that contradicts nothing but is simply unknown.
  ['R-103', 'Odd Purity Ring', 'Ring', '19K', '5.000', '5.000', '800', '0', '1', ''],
];

function writeSheet(rows: string[][], name = 'shop.xlsx'): string {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), 'Stock');
  const path = join(dir, name);
  writeFileSync(path, XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer);
  return path;
}

describe('a realistic shop sheet', () => {
  it('maps the awkward headers without any manual help', () => {
    const res = analyseItemSheet(db, { filePath: writeSheet(SHEET) });
    expect(res.mapping).toMatchObject({
      tagNumber: 'Tag No.',
      name: 'Particulars',
      productType: 'Category',
      purity: 'Purity',
      grossWeight: 'Gross Wt (gms)',
      netWeight: 'Net Wt (gms)',
      makingRate: 'Making /gm',
      wastage: 'Wastage %',
      pieces: 'Qty',
      notes: 'Remarks',
    });
    expect(res.missingRequired).toEqual([]);
  });

  it('separates the four good rows from the three broken ones', () => {
    const res = analyseItemSheet(db, { filePath: writeSheet(SHEET) });
    // The blank row is dropped, not counted as a failure.
    expect(res.totalRows).toBe(7);
    expect(res.okRows).toBe(4);
    expect(res.errorRows).toBe(3);
  });

  it('explains each broken row in terms the shopkeeper can act on', () => {
    const res = analyseItemSheet(db, { filePath: writeSheet(SHEET) });
    const bad = res.rows.filter((r) => !r.ok);
    const byName = Object.fromEntries(bad.map((r) => [r.preview.name, r.errors.join(' ')]));

    expect(byName['Bad Weights Ring']).toContain('net weight is greater than gross');
    expect(byName['Mystery Object']).toContain('Spaceship');
    expect(byName['Odd Purity Ring']).toContain('unknown purity');
  });

  it('imports the good rows and leaves the broken ones out', () => {
    const path = writeSheet(SHEET);
    const analysis = analyseItemSheet(db, { filePath: path });
    const good = analysis.rows.filter((r) => r.ok).map((r) => r.rowNumber);

    const res = commitItemImport(db, 1, {
      filePath: path,
      rowNumbers: good,
      postOpeningStock: true,
    });
    expect(res.imported).toBe(4);

    const items = db
      .prepare(
        `SELECT i.tag_number, i.name, i.tracking_mode, i.gross_mg, i.net_mg,
                i.making_rate_paisa, i.wastage_bp, m.name AS metal, b.pieces
         FROM items i
         JOIN metals m ON m.id = i.metal_id
         JOIN item_balances b ON b.item_id = i.id
         ORDER BY i.id`,
      )
      .all();

    expect(items).toEqual([
      {
        tag_number: 'R-101',
        name: 'Ladies Ring Zircon',
        tracking_mode: 'ITEM',
        gross_mg: 4_250,
        net_mg: 3_900,
        making_rate_paisa: 120_000, // "1,200" rupees -> paisa
        wastage_bp: 800, // 8%
        metal: 'Gold',
        pieces: 1,
      },
      {
        tag_number: 'N-204',
        name: 'Bridal Set Heavy',
        tracking_mode: 'ITEM',
        gross_mg: 85_500,
        net_mg: 78_250,
        making_rate_paisa: 150_000,
        wastage_bp: 1_000,
        metal: 'Gold',
        pieces: 1,
      },
      {
        tag_number: 'TAG-000001', // allocated, because the sheet left it blank
        name: 'Gents Chain',
        tracking_mode: 'ITEM',
        gross_mg: 32_000,
        net_mg: 32_000,
        making_rate_paisa: 90_000,
        wastage_bp: 500,
        metal: 'Gold',
        pieces: 1,
      },
      {
        tag_number: 'B-500',
        name: 'Silver Payal Pairs',
        tracking_mode: 'LOT', // 6 pieces of one description
        gross_mg: 45_000,
        net_mg: 45_000,
        making_rate_paisa: 15_000,
        wastage_bp: 0,
        metal: 'Silver', // taken from the "Silver 925" purity
        pieces: 6,
      },
    ]);
  });

  it('carries the deducted stone weight through as less weight', () => {
    const path = writeSheet(SHEET);
    const good = analyseItemSheet(db, { filePath: path })
      .rows.filter((r) => r.ok)
      .map((r) => r.rowNumber);
    commitItemImport(db, 1, { filePath: path, rowNumbers: good, postOpeningStock: true });

    const row = db.prepare(`SELECT less_mg FROM items WHERE tag_number='R-101'`).get();
    expect(row).toEqual({ less_mg: 350 }); // 4.250 - 3.900 grams
  });

  it('leaves the shop untouched if the user imports without deselecting the bad rows', () => {
    const path = writeSheet(SHEET);
    expect(() => commitItemImport(db, 1, { filePath: path, postOpeningStock: true })).toThrow();
    expect(db.prepare('SELECT count(*) c FROM items').get()).toEqual({ c: 0 });
    expect(db.prepare('SELECT count(*) c FROM stock_movements').get()).toEqual({ c: 0 });
  });

  it('reads the same data when the sheet is saved as CSV instead', () => {
    const csv = SHEET.map((r) => r.map((c) => (c.includes(',') ? `"${c}"` : c)).join(',')).join(
      '\r\n',
    );
    const path = join(dir, 'shop.csv');
    writeFileSync(path, csv, 'utf8');

    const res = analyseItemSheet(db, { filePath: path });
    expect(res.okRows).toBe(4);
    expect(res.errorRows).toBe(3);
  });

  it('reads the whole sheet in tola when the shop keeps weights that way', () => {
    const tolaSheet = [
      ['Tag No.', 'Particulars', 'Category', 'Purity', 'Gross Wt', 'Net Wt'],
      ['T-1', 'One Tola Coin', 'Coin / Bar', '24K / 999', '1', '1'],
    ];
    const res = analyseItemSheet(db, {
      filePath: writeSheet(tolaSheet, 'tola.xlsx'),
      weightUnit: 'tola',
    });
    expect(res.rows[0].prepared?.grossMg).toBe(11_664);
  });
});
