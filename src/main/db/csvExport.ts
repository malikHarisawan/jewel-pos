/**
 * Full-database CSV export — one .csv file per table, written into a
 * timestamped folder the owner can open in Excel or hand to an accountant.
 *
 * This is deliberately NOT a backup. A backup is a byte-copy of the database
 * meant to be restored; this is a readable snapshot meant to be looked at.
 * Restoring from these CSVs is not supported and is not a goal — `backup.ts`
 * owns that job.
 *
 * Two rules shape the output:
 *   1. Secrets never leave the database. `users.pin_hash` and the license
 *      columns are the shop's credentials; a CSV folder gets copied onto USB
 *      sticks and emailed, so those columns are redacted at the source rather
 *      than filtered by the caller.
 *   2. The table list is read from sqlite_master, not hardcoded. A migration
 *      that adds a table gets exported without anyone remembering to come back
 *      here.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DB } from './connection.js';

/**
 * Columns whose values are never written out, keyed by table. The column is
 * still present in the CSV header so the shape matches the schema — the cell
 * just reads REDACTED.
 */
const REDACTED_COLUMNS: Record<string, readonly string[]> = {
  users: ['pin_hash'],
  license: ['license_code', 'machine_id'],
};

const REDACTION = 'REDACTED';

/**
 * Quote a single CSV field per RFC 4180.
 *
 * Excel is the target reader, which forces two decisions:
 *   - NULL becomes an empty cell, not the text "null". A jewellery ledger is
 *     full of legitimately-empty columns and "null" in a money column is worse
 *     than blank.
 *   - A value that starts with = + - or @ is prefixed with a single quote.
 *     Excel treats those as formulas, so an item named "=cmd" in the shop's
 *     inventory would execute on open. This is CSV injection and the fix
 *     belongs here, at the point of writing.
 */
export function csvCell(value: unknown): string {
  if (value === null || value === undefined) return '';

  // better-sqlite3 hands back Buffers for BLOB columns (item photos). Their
  // bytes are meaningless in a spreadsheet and would blow up the file size,
  // so record the size instead of the content.
  if (value instanceof Uint8Array) return `<${value.byteLength} bytes>`;

  let s = String(value);
  if (/^[=+\-@]/.test(s)) s = `'${s}`;

  if (/[",\r\n]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

/** Join one row's already-escaped cells. */
function csvRow(values: readonly unknown[]): string {
  return values.map(csvCell).join(',');
}

/** Every real table in the database, alphabetically. Views and sqlite internals excluded. */
export function listTables(db: DB): string[] {
  const rows = db
    .prepare(
      `SELECT name FROM sqlite_master
        WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
        ORDER BY name`,
    )
    .all() as { name: string }[];
  return rows.map((r) => r.name);
}

/**
 * Render one table as a CSV string: header row, then every row.
 *
 * Reads the whole table into memory. That is fine for a single shop's data —
 * the largest table is stock_movements and a busy shop writes a few thousand
 * rows a year — and it keeps the function pure and testable.
 */
export function tableToCsv(db: DB, table: string): string {
  // Table names cannot be bound as parameters. `table` comes from
  // sqlite_master, never from user input, but quote it anyway so a table named
  // with a reserved word still works.
  const quoted = `"${table.replace(/"/g, '""')}"`;
  const stmt = db.prepare(`SELECT * FROM ${quoted}`);
  const columns = stmt.columns().map((c) => c.name);
  const redacted = new Set(REDACTED_COLUMNS[table] ?? []);

  const lines = [csvRow(columns)];
  for (const row of stmt.raw().all() as unknown[][]) {
    lines.push(
      csvRow(row.map((cell, i) => (redacted.has(columns[i]) ? REDACTION : cell))),
    );
  }
  // Trailing newline: some tools treat a missing final newline as a truncated file.
  return `${lines.join('\r\n')}\r\n`;
}

export interface ExportedTable {
  table: string;
  rows: number;
}

export interface CsvExportResult {
  /** Folder name only — the renderer never sees absolute paths. */
  folder: string;
  tables: ExportedTable[];
  totalRows: number;
}

function stamp(now: Date): string {
  return now.toISOString().replace(/[:.]/g, '-');
}

/**
 * Write every table to `<dir>/csv-<timestamp>/<table>.csv`.
 *
 * The whole export goes into its own timestamped folder so repeated exports
 * never overwrite each other and the user can tell at a glance when a dump was
 * taken.
 */
export function exportAllToCsv(db: DB, dir: string, now: Date): CsvExportResult {
  const folder = `csv-${stamp(now)}`;
  const target = join(dir, folder);
  mkdirSync(target, { recursive: true });

  const tables: ExportedTable[] = [];
  let totalRows = 0;

  for (const table of listTables(db)) {
    const csv = tableToCsv(db, table);
    writeFileSync(join(target, `${table}.csv`), csv, 'utf8');
    // Header line is not a data row, and the trailing newline adds an empty
    // final segment — hence the -1 on the split count.
    const rows = csv.split('\r\n').length - 2;
    tables.push({ table, rows });
    totalRows += rows;
  }

  return { folder, tables, totalRows };
}
