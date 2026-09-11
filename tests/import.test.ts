import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as XLSX from 'xlsx';
import { openDatabase, type DB } from '../src/main/db/connection.js';
import {
  guessMapping,
  normalizeHeader,
  parseCount,
  parseMakingMode,
  parseMoneyPaisa,
  parseNumber,
  parsePercentBp,
  parseWeightMg,
  parseWeightUnit,
} from '../src/main/import/columns.js';
import { gridToRecords } from '../src/main/import/sheet.js';
import { analyseItemSheet, commitItemImport } from '../src/main/import/itemImport.js';

let db: DB;
let dir: string;

beforeEach(() => {
  db = openDatabase({ filename: ':memory:' });
  db.prepare(
    `INSERT INTO users (id, username, display_name, pin_hash, role) VALUES (1,'owner','Owner','x','OWNER')`,
  ).run();
  dir = mkdtempSync(join(tmpdir(), 'jp-import-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Serialise a workbook and write it with Node's fs.
 *
 * XLSX.writeFile is avoided deliberately: under Vite's ESM transform SheetJS
 * cannot resolve its internal `fs` binding and throws "cannot save file".
 * Asking it for a buffer keeps the file writing on our side, which is also
 * what the production reader does. */
function writeBook(wb: XLSX.WorkBook, name: string): string {
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
  const path = join(dir, name);
  writeFileSync(path, buf);
  return path;
}

/** Write a sheet of rows (row 0 = header) to a real .xlsx and return its path. */
function writeXlsx(rows: string[][], name = 'stock.xlsx', sheetName = 'Sheet1'): string {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), sheetName);
  return writeBook(wb, name);
}

function writeCsv(text: string, name = 'stock.csv'): string {
  const path = join(dir, name);
  writeFileSync(path, text, 'utf8');
  return path;
}

// ---------------------------------------------------------------------------

describe('header normalisation and mapping', () => {
  it('collapses punctuation and case', () => {
    expect(normalizeHeader('Gross Wt. (g)')).toBe('grosswtg');
    expect(normalizeHeader('  NET_WEIGHT  ')).toBe('netweight');
  });

  it('maps the common shop headers', () => {
    const m = guessMapping(['Tag No', 'Description', 'Gross Wt', 'Net Wt', 'Purity', 'Making/gm']);
    expect(m.tagNumber).toBe('Tag No');
    expect(m.name).toBe('Description');
    expect(m.grossWeight).toBe('Gross Wt');
    expect(m.netWeight).toBe('Net Wt');
    expect(m.purity).toBe('Purity');
    expect(m.makingRate).toBe('Making/gm');
  });

  it('never binds one column to two fields', () => {
    // "Weight" is an alias of grossWeight only; "Net" must not also grab it.
    const m = guessMapping(['Item', 'Weight']);
    const used = Object.values(m);
    expect(new Set(used).size).toBe(used.length);
  });

  it('leaves unrecognised headers unmapped rather than guessing', () => {
    const m = guessMapping(['Item Name', 'Zyx Column']);
    expect(Object.values(m)).not.toContain('Zyx Column');
  });

  it('sees through a unit written into the header', () => {
    const m = guessMapping(['Particulars', 'Gross Wt (gms)', 'Net Weight in grams']);
    expect(m.grossWeight).toBe('Gross Wt (gms)');
    expect(m.netWeight).toBe('Net Weight in grams');
  });

  it('prefers an exact header over one that only matches once the unit is stripped', () => {
    // "Net Wt" is exact; "Weight (gms)" only matches grossWeight after
    // stripping. Neither should steal the other's column.
    const m = guessMapping(['Item', 'Weight (gms)', 'Net Wt']);
    expect(m.netWeight).toBe('Net Wt');
    expect(m.grossWeight).toBe('Weight (gms)');
  });

  it('does not mistake a plain unit column for a weight', () => {
    const m = guessMapping(['Item Name', 'Gross Wt', 'Unit']);
    expect(m.weightUnit).toBe('Unit');
    expect(m.grossWeight).toBe('Gross Wt');
  });
});

describe('number parsing', () => {
  it('reads plain and decorated numbers', () => {
    expect(parseNumber('12.5')).toEqual({ ok: true, value: 12.5 });
    expect(parseNumber('12.5 g')).toEqual({ ok: true, value: 12.5 });
    expect(parseNumber('Rs 1,234.50')).toEqual({ ok: true, value: 1234.5 });
    expect(parseNumber('8%')).toEqual({ ok: true, value: 8 });
    expect(parseNumber('(50)')).toEqual({ ok: true, value: -50 });
  });

  it('refuses an ambiguous decimal comma instead of guessing', () => {
    const r = parseNumber('12,5');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('ambiguous');
  });

  it('rejects text', () => {
    expect(parseNumber('abc').ok).toBe(false);
    expect(parseNumber('').ok).toBe(false);
  });
});

describe('unit conversion', () => {
  it('converts grams to milligrams', () => {
    expect(parseWeightMg('12.345', 'g', 11664)).toEqual({ ok: true, value: 12345 });
  });

  it('converts tola using the shop tola size', () => {
    expect(parseWeightMg('1', 'tola', 11664)).toEqual({ ok: true, value: 11664 });
  });

  it('passes milligrams through', () => {
    expect(parseWeightMg('500', 'mg', 11664)).toEqual({ ok: true, value: 500 });
  });

  it('reads a unit word from a cell', () => {
    expect(parseWeightUnit('tola')).toBe('tola');
    expect(parseWeightUnit('gms')).toBe('g');
    expect(parseWeightUnit('')).toBe('g');
  });

  it('rejects negative weight', () => {
    expect(parseWeightMg('-1', 'g', 11664).ok).toBe(false);
  });
});

describe('money and percent parsing', () => {
  it('reads rupees as paisa', () => {
    expect(parseMoneyPaisa('1500')).toEqual({ ok: true, value: 150000 });
    expect(parseMoneyPaisa('1,234.56')).toEqual({ ok: true, value: 123456 });
  });

  it('reads a percentage as basis points, literally', () => {
    expect(parsePercentBp('8')).toEqual({ ok: true, value: 800 });
    expect(parsePercentBp('8%')).toEqual({ ok: true, value: 800 });
    // A bare fraction is NOT silently treated as 8%.
    expect(parsePercentBp('0.08')).toEqual({ ok: true, value: 8 });
  });

  it('rejects a percentage over 100', () => {
    expect(parsePercentBp('120').ok).toBe(false);
  });

  it('reads making basis words', () => {
    expect(parseMakingMode('per gram')).toEqual({ ok: true, value: 'PER_GRAM' });
    expect(parseMakingMode('Fixed')).toEqual({ ok: true, value: 'FIXED' });
    expect(parseMakingMode('')).toEqual({ ok: true, value: 'PER_GRAM' });
    expect(parseMakingMode('sideways').ok).toBe(false);
  });

  it('rejects a fractional piece count', () => {
    expect(parseCount('2.5').ok).toBe(false);
    expect(parseCount('3')).toEqual({ ok: true, value: 3 });
  });
});

describe('grid to records', () => {
  it('keys cells by header and skips blank rows', () => {
    const { headers, records } = gridToRecords([
      ['Name', 'Wt'],
      ['Ring', '5'],
      ['', ''],
      ['Chain', '10'],
    ]);
    expect(headers).toEqual(['Name', 'Wt']);
    expect(records).toEqual([
      { Name: 'Ring', Wt: '5' },
      { Name: 'Chain', Wt: '10' },
    ]);
  });
});

// ---------------------------------------------------------------------------

describe('analysing a sheet', () => {
  it('validates a clean xlsx and reports every row importable', () => {
    const path = writeXlsx([
      ['Tag No', 'Item Name', 'Type', 'Purity', 'Gross Wt', 'Net Wt', 'Making/gm'],
      ['A-1', 'Gold Ring', 'Ring', '22K', '10.5', '10.0', '500'],
      ['A-2', 'Gold Chain', 'Chain', '21K', '25.0', '25.0', '400'],
    ]);
    const res = analyseItemSheet(db, { filePath: path });

    expect(res.totalRows).toBe(2);
    expect(res.okRows).toBe(2);
    expect(res.errorRows).toBe(0);
    expect(res.missingRequired).toEqual([]);
    expect(res.rows[0].rowNumber).toBe(2); // header is row 1
  });

  it('reads a csv the same way as an xlsx', () => {
    const path = writeCsv('Item Name,Gross Wt\nSilver Payal,20\n');
    const res = analyseItemSheet(db, { filePath: path });
    expect(res.okRows).toBe(1);
    expect(res.rows[0].preview.name).toBe('Silver Payal');
  });

  it('derives the third weight from the other two', () => {
    const path = writeXlsx([
      ['Item Name', 'Gross Wt', 'Net Wt'],
      ['Stone Set', '20', '17.5'],
    ]);
    const res = analyseItemSheet(db, { filePath: path });
    expect(res.rows[0].ok).toBe(true);
    expect(res.rows[0].prepared).toMatchObject({
      grossMg: 20_000,
      netMg: 17_500,
      lessMg: 2_500,
    });
  });

  it('rejects a row whose three weights contradict each other', () => {
    const path = writeXlsx([
      ['Item Name', 'Gross Wt', 'Less Wt', 'Net Wt'],
      ['Bad Row', '20', '1', '17.5'],
    ]);
    const res = analyseItemSheet(db, { filePath: path });
    expect(res.rows[0].ok).toBe(false);
    expect(res.rows[0].errors.join(' ')).toContain('do not add up');
  });

  it('rejects net heavier than gross', () => {
    const path = writeXlsx([
      ['Item Name', 'Gross Wt', 'Net Wt'],
      ['Impossible', '10', '12'],
    ]);
    const res = analyseItemSheet(db, { filePath: path });
    expect(res.rows[0].ok).toBe(false);
  });

  it('flags an unknown category by name and lists the known ones', () => {
    const path = writeXlsx([
      ['Item Name', 'Gross Wt', 'Type'],
      ['Mystery', '5', 'Spaceship'],
    ]);
    const res = analyseItemSheet(db, { filePath: path });
    expect(res.rows[0].ok).toBe(false);
    expect(res.rows[0].errors.join(' ')).toContain('Spaceship');
    expect(res.rows[0].errors.join(' ')).toContain('Ring');
  });

  it('matches purity written as karat, fineness or full label', () => {
    const path = writeXlsx([
      ['Item Name', 'Gross Wt', 'Purity'],
      ['A', '5', '22'],
      ['B', '5', '916'],
      ['C', '5', '22K / 916'],
    ]);
    const res = analyseItemSheet(db, { filePath: path });
    expect(res.okRows).toBe(3);
    const ids = res.rows.map((r) => r.prepared?.purityId);
    expect(new Set(ids).size).toBe(1); // all three resolved to the same purity
  });

  it('rejects a purity that belongs to a different metal than the metal column', () => {
    const path = writeXlsx([
      ['Item Name', 'Gross Wt', 'Metal', 'Purity'],
      ['Confused', '5', 'Silver', '22K / 916'],
    ]);
    const res = analyseItemSheet(db, { filePath: path });
    expect(res.rows[0].ok).toBe(false);
    expect(res.rows[0].errors.join(' ')).toContain('does not belong');
  });

  it('flags both rows of a duplicate tag pair, not just the second', () => {
    const path = writeXlsx([
      ['Tag No', 'Item Name', 'Gross Wt'],
      ['DUP-1', 'First', '5'],
      ['DUP-1', 'Second', '6'],
    ]);
    const res = analyseItemSheet(db, { filePath: path });
    expect(res.rows[0].ok).toBe(false);
    expect(res.rows[1].ok).toBe(false);
    expect(res.rows[0].errors.join(' ')).toContain('repeated');
  });

  it('flags a tag that already exists in the shop', () => {
    const first = writeXlsx([
      ['Tag No', 'Item Name', 'Gross Wt'],
      ['EXIST-1', 'Already here', '5'],
    ]);
    commitItemImport(db, 1, { filePath: first, postOpeningStock: true });

    const again = writeXlsx(
      [
        ['Tag No', 'Item Name', 'Gross Wt'],
        ['EXIST-1', 'Same tag again', '7'],
      ],
      'again.xlsx',
    );
    const res = analyseItemSheet(db, { filePath: again });
    expect(res.rows[0].ok).toBe(false);
    expect(res.rows[0].errors.join(' ')).toContain('already exists');
  });

  it('refuses a tag in the reserved RAW-/SCRAP- space', () => {
    const path = writeXlsx([
      ['Tag No', 'Item Name', 'Gross Wt'],
      ['RAW-9', 'Sneaky', '5'],
    ]);
    const res = analyseItemSheet(db, { filePath: path });
    expect(res.rows[0].ok).toBe(false);
    expect(res.rows[0].errors.join(' ')).toContain('reserved');
  });

  it('names the missing required column instead of failing every row silently', () => {
    const path = writeXlsx([
      ['Tag No', 'Gross Wt'],
      ['T-1', '5'],
    ]);
    const res = analyseItemSheet(db, { filePath: path });
    expect(res.missingRequired).toContain('name');
    expect(res.rows[0].ok).toBe(false);
  });

  it('previews the RESOLVED values, not the text the sheet used', () => {
    // The sheet says "22" and "Ring"; the preview must show what the item will
    // actually become, because that is what the shopkeeper is approving.
    const path = writeXlsx([
      ['Tag No', 'Item Name', 'Type', 'Purity', 'Gross Wt', 'Net Wt', 'Making/gm', 'Wastage %'],
      ['P-1', 'Ladies Ring', 'Ring', '22', '4.250', '3.900', '1200', '8'],
    ]);
    const res = analyseItemSheet(db, { filePath: path });

    expect(res.rows[0].preview).toEqual({
      tag: 'P-1',
      name: 'Ladies Ring',
      trackingMode: 'ITEM',
      productType: 'Ring',
      metal: 'Gold', // never named in the sheet — comes from the purity
      purity: '22K / 916', // the app's label, not the sheet's "22"
      location: 'Main Shop', // the default, since the sheet has no location
      grossMg: 4_250,
      lessMg: 350,
      netMg: 3_900,
      pieces: 1,
      makingMode: 'PER_GRAM',
      makingRatePaisa: 120_000,
      wastageBp: 800,
    });
  });

  it('does not warn when the purity alone decides the metal', () => {
    // No Metal column at all is an ordinary sheet, not something to flag. The
    // preview shows the resolved metal, so a warning here would only be noise —
    // and noise on normal rows is what makes real warnings get skimmed past.
    const path = writeXlsx([
      ['Item Name', 'Gross Wt', 'Purity'],
      ['Silver Payal', '45', 'Silver 925'],
    ]);
    const res = analyseItemSheet(db, { filePath: path });
    expect(res.rows[0].ok).toBe(true);
    expect(res.rows[0].warnings).toEqual([]);
    expect(res.rows[0].preview.metal).toBe('Silver');
  });

  it('previews a multi-piece row as a LOT', () => {
    const path = writeXlsx([
      ['Item Name', 'Gross Wt', 'Qty'],
      ['Bangle Lot', '5', '12'],
    ]);
    const res = analyseItemSheet(db, { filePath: path });
    expect(res.rows[0].preview).toMatchObject({ trackingMode: 'LOT', pieces: 12 });
  });

  it('leaves the preview tag blank when one will be allocated', () => {
    const path = writeXlsx([
      ['Item Name', 'Gross Wt'],
      ['No Tag Here', '5'],
    ]);
    const res = analyseItemSheet(db, { filePath: path });
    expect(res.rows[0].preview.tag).toBe('');
  });

  it('still previews the parts it could work out on a failed row', () => {
    // A row that fails on one field must not come back blank: the name and the
    // fields that did parse are how the user finds the row in their sheet.
    const path = writeXlsx([
      ['Tag No', 'Item Name', 'Type', 'Gross Wt', 'Net Wt'],
      ['F-1', 'Broken Weights', 'Ring', '5', '6'],
    ]);
    const res = analyseItemSheet(db, { filePath: path });
    expect(res.rows[0].ok).toBe(false);
    expect(res.rows[0].preview).toMatchObject({
      tag: 'F-1',
      name: 'Broken Weights',
      productType: 'Ring',
    });
  });

  it('previews a percentage making charge as basis points, not paisa', () => {
    const path = writeXlsx([
      ['Item Name', 'Gross Wt', 'Making Basis', 'Making Rate'],
      ['Pct Making', '10', 'percent', '12'],
    ]);
    const res = analyseItemSheet(db, { filePath: path });
    expect(res.rows[0].preview).toMatchObject({
      makingMode: 'PCT_OF_METAL',
      makingRatePaisa: 1_200, // 12% as bp, NOT Rs 12 as paisa
    });
  });

  it('imports a name-only sheet, leaving the rest to be filled in later', () => {
    const path = writeXlsx([['Item Name'], ['Gold Ring'], ['Silver Chain']]);
    const res = analyseItemSheet(db, { filePath: path });

    expect(res.missingRequired).toEqual([]);
    expect(res.okRows).toBe(2);
    expect(res.rows[0].prepared).toMatchObject({ name: 'Gold Ring', grossMg: 0, netMg: 0 });
  });

  it('warns that a weightless row came in at zero rather than staying silent', () => {
    const path = writeXlsx([['Item Name'], ['No Weight Yet']]);
    const res = analyseItemSheet(db, { filePath: path });
    expect(res.rows[0].ok).toBe(true);
    expect(res.rows[0].warnings.join(' ')).toContain('0');
  });

  it('still rejects a weight that is present but unreadable', () => {
    // A blank weight is a gap; "abc" is a mistake. Zeroing it would turn a
    // typo into a wrong weight on the shelf.
    const path = writeXlsx([
      ['Item Name', 'Gross Wt'],
      ['Typo Row', 'abc'],
    ]);
    const res = analyseItemSheet(db, { filePath: path });
    expect(res.rows[0].ok).toBe(false);
    expect(res.rows[0].errors.join(' ')).toContain('not a number');
  });

  it('imports rows that have a weight alongside rows that do not', () => {
    const path = writeXlsx([
      ['Item Name', 'Gross Wt'],
      ['Weighed', '5'],
      ['Not Weighed', ''],
    ]);
    const res = analyseItemSheet(db, { filePath: path });
    expect(res.okRows).toBe(2);
    expect(res.rows[0].prepared?.grossMg).toBe(5_000);
    expect(res.rows[1].prepared?.grossMg).toBe(0);
  });

  it('takes a sheet of names and prices, ignoring the column it has no field for', () => {
    const path = writeXlsx([
      ['Particulars', 'Sale Price'],
      ['Ladies Ring', '45000'],
    ]);
    const res = analyseItemSheet(db, { filePath: path });
    expect(res.okRows).toBe(1);
    expect(res.rows[0].prepared?.name).toBe('Ladies Ring');
  });

  it('honours a manual mapping override', () => {
    const path = writeXlsx([
      ['Column A', 'Column B'],
      ['Handmade Bangle', '15'],
    ]);
    const guessed = analyseItemSheet(db, { filePath: path });
    expect(guessed.missingRequired.length).toBeGreaterThan(0);

    const fixed = analyseItemSheet(db, {
      filePath: path,
      mapping: { name: 'Column A', grossWeight: 'Column B' },
    });
    expect(fixed.okRows).toBe(1);
    expect(fixed.rows[0].prepared?.name).toBe('Handmade Bangle');
    expect(fixed.rows[0].prepared?.grossMg).toBe(15_000);
  });

  it('ignores a mapping override naming a column that is not in the file', () => {
    const path = writeXlsx([
      ['Item Name', 'Gross Wt'],
      ['Ring', '5'],
    ]);
    const res = analyseItemSheet(db, {
      filePath: path,
      mapping: { netWeight: 'A Column From Another File' },
    });
    expect(res.mapping.netWeight).toBeUndefined();
    expect(res.okRows).toBe(1);
  });

  it('reads the whole sheet in tola when told to', () => {
    const path = writeXlsx([
      ['Item Name', 'Gross Wt'],
      ['One Tola Coin', '1'],
    ]);
    const res = analyseItemSheet(db, { filePath: path, weightUnit: 'tola' });
    expect(res.rows[0].prepared?.grossMg).toBe(11_664);
  });

  it('lets a per-row unit column override the sheet default', () => {
    const path = writeXlsx([
      ['Item Name', 'Gross Wt', 'Unit'],
      ['In tola', '1', 'tola'],
      ['In grams', '1', 'g'],
    ]);
    const res = analyseItemSheet(db, { filePath: path });
    expect(res.rows[0].prepared?.grossMg).toBe(11_664);
    expect(res.rows[1].prepared?.grossMg).toBe(1_000);
  });

  it('lists every sheet and reads the one asked for', () => {
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(
      wb,
      XLSX.utils.aoa_to_sheet([['Item Name', 'Gross Wt'], ['From First', '5']]),
      'First',
    );
    XLSX.utils.book_append_sheet(
      wb,
      XLSX.utils.aoa_to_sheet([['Item Name', 'Gross Wt'], ['From Second', '6']]),
      'Second',
    );
    const path = writeBook(wb, 'multi.xlsx');

    const first = analyseItemSheet(db, { filePath: path });
    expect(first.sheetNames).toEqual(['First', 'Second']);
    expect(first.rows[0].preview.name).toBe('From First');

    const second = analyseItemSheet(db, { filePath: path, sheetName: 'Second' });
    expect(second.rows[0].preview.name).toBe('From Second');
  });

  it('treats several pieces of one description as a lot', () => {
    const path = writeXlsx([
      ['Item Name', 'Gross Wt', 'Qty'],
      ['Single Ring', '5', '1'],
      ['Bangle Lot', '5', '12'],
    ]);
    const res = analyseItemSheet(db, { filePath: path });
    expect(res.rows[0].prepared?.trackingMode).toBe('ITEM');
    expect(res.rows[1].prepared?.trackingMode).toBe('LOT');
    expect(res.rows[1].prepared?.openingPieces).toBe(12);
  });
});

// ---------------------------------------------------------------------------

describe('committing an import', () => {
  it('writes items and posts opening stock', () => {
    const path = writeXlsx([
      ['Tag No', 'Item Name', 'Type', 'Purity', 'Gross Wt', 'Net Wt', 'Making/gm'],
      ['C-1', 'Gold Ring', 'Ring', '22K', '10.5', '10.0', '500'],
      ['C-2', 'Gold Chain', 'Chain', '21K', '25.0', '25.0', '400'],
    ]);
    const res = commitItemImport(db, 1, { filePath: path, postOpeningStock: true });

    expect(res.imported).toBe(2);
    expect(res.openingMovements).toBe(2);

    const items = db.prepare('SELECT tag_number, name, gross_mg, net_mg FROM items ORDER BY id').all();
    expect(items).toEqual([
      { tag_number: 'C-1', name: 'Gold Ring', gross_mg: 10_500, net_mg: 10_000 },
      { tag_number: 'C-2', name: 'Gold Chain', gross_mg: 25_000, net_mg: 25_000 },
    ]);

    const bal = db
      .prepare('SELECT pieces, net_mg FROM item_balances ORDER BY item_id')
      .all() as Array<{ pieces: number; net_mg: number }>;
    expect(bal).toEqual([
      { pieces: 1, net_mg: 10_000 },
      { pieces: 1, net_mg: 25_000 },
    ]);
  });

  it('can import without posting stock', () => {
    const path = writeXlsx([
      ['Item Name', 'Gross Wt'],
      ['Not in stock yet', '5'],
    ]);
    const res = commitItemImport(db, 1, { filePath: path, postOpeningStock: false });
    expect(res.imported).toBe(1);
    expect(res.openingMovements).toBe(0);
    expect(db.prepare('SELECT count(*) c FROM stock_movements').get()).toEqual({ c: 0 });
  });

  it('opens a lot with its full piece count', () => {
    const path = writeXlsx([
      ['Item Name', 'Gross Wt', 'Qty'],
      ['Bangle Lot', '5', '12'],
    ]);
    commitItemImport(db, 1, { filePath: path, postOpeningStock: true });
    const bal = db.prepare('SELECT pieces, net_mg FROM item_balances').get();
    expect(bal).toEqual({ pieces: 12, net_mg: 60_000 });
  });

  it('imports nothing at all when any selected row is invalid', () => {
    const path = writeXlsx([
      ['Item Name', 'Gross Wt', 'Type'],
      ['Good One', '5', 'Ring'],
      ['Bad One', '5', 'Spaceship'],
    ]);
    expect(() => commitItemImport(db, 1, { filePath: path, postOpeningStock: true })).toThrow(
      /not valid/,
    );
    // The good row must not have landed either.
    expect(db.prepare('SELECT count(*) c FROM items').get()).toEqual({ c: 0 });
  });

  it('imports only the rows the user ticked', () => {
    const path = writeXlsx([
      ['Item Name', 'Gross Wt', 'Type'],
      ['Keep Me', '5', 'Ring'],
      ['Skip Me', '5', 'Spaceship'],
    ]);
    const res = commitItemImport(db, 1, {
      filePath: path,
      postOpeningStock: true,
      rowNumbers: [2],
    });
    expect(res.imported).toBe(1);
    const names = db.prepare('SELECT name FROM items').all();
    expect(names).toEqual([{ name: 'Keep Me' }]);
  });

  it('generates sequential tags for untagged rows without colliding', () => {
    const path = writeXlsx([
      ['Item Name', 'Gross Wt'],
      ['No Tag A', '5'],
      ['No Tag B', '6'],
      ['No Tag C', '7'],
    ]);
    commitItemImport(db, 1, { filePath: path, postOpeningStock: true });
    const tags = (db.prepare('SELECT tag_number FROM items ORDER BY id').all() as Array<{
      tag_number: string;
    }>).map((r) => r.tag_number);
    expect(tags).toEqual(['TAG-000001', 'TAG-000002', 'TAG-000003']);
  });

  it('continues the tag sequence across two imports', () => {
    const a = writeXlsx([['Item Name', 'Gross Wt'], ['First', '5']], 'a.xlsx');
    const b = writeXlsx([['Item Name', 'Gross Wt'], ['Second', '5']], 'b.xlsx');
    commitItemImport(db, 1, { filePath: a, postOpeningStock: true });
    commitItemImport(db, 1, { filePath: b, postOpeningStock: true });
    const tags = (db.prepare('SELECT tag_number FROM items ORDER BY id').all() as Array<{
      tag_number: string;
    }>).map((r) => r.tag_number);
    expect(tags).toEqual(['TAG-000001', 'TAG-000002']);
  });

  it('records one audit entry for the batch, not one per row', () => {
    const path = writeXlsx([
      ['Item Name', 'Gross Wt'],
      ['A', '5'],
      ['B', '5'],
      ['C', '5'],
    ]);
    commitItemImport(db, 1, { filePath: path, postOpeningStock: false });
    const rows = db
      .prepare(`SELECT changes_json FROM audit_log WHERE table_name='items' AND row_pk=0`)
      .all() as Array<{ changes_json: string }>;
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0].changes_json)).toMatchObject({ importedItems: 3 });
  });

  it('puts a weightless item into stock at zero so it can be corrected later', () => {
    const path = writeXlsx([['Item Name'], ['Weigh Me Later']]);
    const res = commitItemImport(db, 1, { filePath: path, postOpeningStock: true });
    expect(res.imported).toBe(1);
    expect(res.openingMovements).toBe(1);

    const row = db
      .prepare(
        `SELECT i.name, i.gross_mg, i.net_mg, i.status, b.pieces, b.net_mg AS bal_net
         FROM items i JOIN item_balances b ON b.item_id = i.id`,
      )
      .get();
    expect(row).toEqual({
      name: 'Weigh Me Later',
      gross_mg: 0,
      net_mg: 0,
      status: 'IN_STOCK',
      pieces: 1, // the piece is on the shelf even though its weight is unknown
      bal_net: 0,
    });
  });

  it('refuses an empty selection', () => {
    const path = writeXlsx([['Item Name', 'Gross Wt'], ['A', '5']]);
    expect(() =>
      commitItemImport(db, 1, { filePath: path, postOpeningStock: true, rowNumbers: [] }),
    ).toThrow(/no rows/);
  });

  it('files the item under the metal its purity belongs to', () => {
    const path = writeXlsx([
      ['Item Name', 'Gross Wt', 'Purity'],
      ['Silver Payal', '20', 'Silver 925'],
    ]);
    commitItemImport(db, 1, { filePath: path, postOpeningStock: true });
    const row = db
      .prepare(
        `SELECT m.name FROM items i JOIN metals m ON m.id = i.metal_id`,
      )
      .get();
    expect(row).toEqual({ name: 'Silver' });
  });
});
