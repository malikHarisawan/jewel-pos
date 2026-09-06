/**
 * Full-database CSV export.
 *
 * The shop could back its data up but could never read it — a .db file is not
 * something an accountant can open. This dump fills that gap, which means it
 * leaves the machine: onto USB sticks, into email. These tests pin the three
 * things that makes dangerous — credentials must not ride along, a spreadsheet
 * must not execute what it reads, and a dump that silently drops today's sales
 * is worse than no dump at all.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openDatabase, type DB } from '../src/main/db/connection.js';
import {
  csvCell,
  listTables,
  tableToCsv,
  exportAllToCsv,
} from '../src/main/db/csvExport.js';

let dir: string;
let db: DB;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'jp-csv-'));
  db = openDatabase({ filename: join(dir, 'shop.db') });
  db.prepare(
    `INSERT INTO users (id, username, display_name, pin_hash, role)
     VALUES (1,'owner','Owner','$argon2-secret-hash','OWNER')`,
  ).run();
});

afterEach(() => {
  try {
    db.close();
  } catch {
    // nothing to do
  }
  rmSync(dir, { recursive: true, force: true });
});

describe('escaping one cell', () => {
  it('leaves a plain value alone', () => {
    expect(csvCell('Gold Ring')).toBe('Gold Ring');
    expect(csvCell(42)).toBe('42');
  });

  it('writes NULL as an empty cell, not the word null', () => {
    // A money column full of "null" is unreadable in Excel.
    expect(csvCell(null)).toBe('');
    expect(csvCell(undefined)).toBe('');
  });

  it('quotes and doubles up embedded quotes, commas and newlines', () => {
    expect(csvCell('Ali, Bilal')).toBe('"Ali, Bilal"');
    expect(csvCell('22" chain')).toBe('"22"" chain"');
    expect(csvCell('line1\nline2')).toBe('"line1\nline2"');
  });

  it('defuses a value Excel would run as a formula', () => {
    // CSV injection: an item named =cmd|... executes when the sheet opens.
    for (const bad of ['=1+1', '+1', '-1', '@SUM(A1)']) {
      expect(csvCell(bad).startsWith("'")).toBe(true);
    }
  });

  it('records a BLOB by size rather than dumping its bytes', () => {
    expect(csvCell(new Uint8Array([1, 2, 3]))).toBe('<3 bytes>');
  });
});

describe('rendering a table', () => {
  it('writes a header row followed by the data', () => {
    const csv = tableToCsv(db, 'users');
    const [header, first] = csv.split('\r\n');
    expect(header.split(',')).toContain('username');
    expect(first).toContain('owner');
  });

  it('never writes the PIN hash', () => {
    // The dump gets copied onto USB sticks; the shop's credentials must not
    // travel with it.
    const csv = tableToCsv(db, 'users');
    expect(csv).not.toContain('$argon2-secret-hash');
    expect(csv).toContain('REDACTED');
    // The column itself stays, so the shape still matches the schema.
    expect(csv.split('\r\n')[0]).toContain('pin_hash');
  });

  it('redacts the license code and machine id', () => {
    db.prepare(
      `INSERT INTO license (id, machine_id, trial_start, license_code, high_water_mark)
       VALUES (1,'MACHINE-XYZ','2026-01-01','SECRET-CODE','2026-01-01')`,
    ).run();
    const csv = tableToCsv(db, 'license');
    expect(csv).not.toContain('SECRET-CODE');
    expect(csv).not.toContain('MACHINE-XYZ');
  });

  it('renders an empty table as a header and nothing else', () => {
    const csv = tableToCsv(db, 'stock_movements');
    expect(csv.split('\r\n').filter(Boolean)).toHaveLength(1);
  });
});

describe('discovering tables', () => {
  it('finds the real tables and skips sqlite internals', () => {
    const tables = listTables(db);
    expect(tables).toContain('users');
    expect(tables).toContain('items');
    expect(tables).toContain('stock_movements');
    expect(tables.some((t) => t.startsWith('sqlite_'))).toBe(false);
  });
});

describe('exporting everything', () => {
  it('writes one csv per table into a timestamped folder', () => {
    const res = exportAllToCsv(db, dir, new Date('2026-09-06T10:00:00Z'));

    expect(res.folder).toMatch(/^csv-/);
    const target = join(dir, res.folder);
    expect(existsSync(target)).toBe(true);

    const files = readdirSync(target);
    expect(files).toContain('users.csv');
    expect(files).toContain('items.csv');
    // Every discovered table produced a file.
    expect(files).toHaveLength(listTables(db).length);
    expect(res.tables).toHaveLength(files.length);
  });

  it('counts rows without counting the header', () => {
    const res = exportAllToCsv(db, dir, new Date());
    const users = res.tables.find((t) => t.table === 'users');
    expect(users?.rows).toBe(1);

    const empty = res.tables.find((t) => t.table === 'stock_movements');
    expect(empty?.rows).toBe(0);
  });

  it('two exports do not overwrite each other', () => {
    const a = exportAllToCsv(db, dir, new Date('2026-09-06T10:00:00Z'));
    const b = exportAllToCsv(db, dir, new Date('2026-09-06T11:00:00Z'));
    expect(a.folder).not.toBe(b.folder);
    expect(existsSync(join(dir, a.folder))).toBe(true);
    expect(existsSync(join(dir, b.folder))).toBe(true);
  });

  it('round-trips a value that needed escaping', () => {
    db.prepare(
      `INSERT INTO users (id, username, display_name, pin_hash, role)
       VALUES (2,'raza','Raza, "Jeweller"','x','SALESMAN')`,
    ).run();
    const res = exportAllToCsv(db, dir, new Date());
    const csv = readFileSync(join(dir, res.folder, 'users.csv'), 'utf8');
    expect(csv).toContain('"Raza, ""Jeweller"""');
  });
});
