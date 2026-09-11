/**
 * Spreadsheet reading — the thin layer over SheetJS.
 *
 * Kept separate from `itemImport.ts` so the mapping rules can be tested against
 * plain arrays without a file on disk. Everything below returns raw strings;
 * interpreting them (weights, money, category names) is the mapper's job.
 *
 * SheetJS is pinned to the vendor's own CDN tarball rather than the npm copy:
 * the registry's `xlsx` stopped at 0.18.5 and carries two unfixed high-severity
 * advisories (prototype pollution, ReDoS). Both are fixed in 0.20.x, which the
 * vendor ships only from cdn.sheetjs.com.
 */
import { readFileSync } from 'node:fs';
import * as XLSX from 'xlsx';

/** A sheet flattened to rows of trimmed strings. Row 0 is the header. */
export type Grid = string[][];

export interface WorkbookSheets {
  /** Sheet names in workbook order. A .csv yields exactly one. */
  names: string[];
  /** Rows keyed by sheet name. */
  sheets: Record<string, Grid>;
}

/** Cells arrive as strings, numbers, dates or undefined. Normalise to a trimmed
 * string so the mapper has exactly one type to reason about. */
function cellToString(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return String(v).trim();
}

/** Drop trailing all-empty rows. Excel files routinely carry thousands of blank
 * rows below the data because someone once clicked there; importing those as
 * "rows with missing name" would bury the real errors. */
function trimGrid(grid: Grid): Grid {
  let lastRow = -1;
  for (let r = 0; r < grid.length; r++) {
    if (grid[r].some((c) => c !== '')) lastRow = r;
  }
  return grid.slice(0, lastRow + 1);
}

/**
 * Read a workbook from disk into plain string grids.
 *
 * `cellDates` keeps dates as Date objects rather than Excel serial numbers, and
 * `raw: false` asks SheetJS for the *formatted* text — so a cell displaying
 * "22K / 916" arrives as that string and not as an internal code.
 */
export function readWorkbook(filePath: string): WorkbookSheets {
  // Read the bytes ourselves rather than using XLSX.readFile: passing a buffer
  // keeps file access in our own code, where the caller's path checks apply.
  const buf = readFileSync(filePath);
  const wb = XLSX.read(buf, { type: 'buffer', cellDates: true, raw: false });

  const sheets: Record<string, Grid> = {};
  for (const name of wb.SheetNames) {
    const ws = wb.Sheets[name];
    if (!ws) continue;
    const rows = XLSX.utils.sheet_to_json<unknown[]>(ws, {
      header: 1,
      blankrows: false,
      defval: '',
      raw: false,
    });
    sheets[name] = trimGrid(rows.map((row) => row.map(cellToString)));
  }
  return { names: wb.SheetNames.filter((n) => n in sheets), sheets };
}

/** Turn a grid into header + record objects keyed by the header text.
 * Duplicate headers keep the first occurrence — a second "Name" column is
 * almost always a stray label, not data. */
export function gridToRecords(grid: Grid): {
  headers: string[];
  records: Array<Record<string, string>>;
} {
  if (grid.length === 0) return { headers: [], records: [] };
  const headers = grid[0].map((h) => h.trim());
  const records: Array<Record<string, string>> = [];

  for (let r = 1; r < grid.length; r++) {
    const row = grid[r];
    // Skip rows that are entirely blank between data blocks.
    if (row.every((c) => c === '')) continue;
    const rec: Record<string, string> = {};
    headers.forEach((h, i) => {
      if (h && !(h in rec)) rec[h] = row[i] ?? '';
    });
    records.push(rec);
  }
  return { headers, records };
}
