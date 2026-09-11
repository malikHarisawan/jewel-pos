/**
 * Generates sample spreadsheets for trying out the importer.
 *
 *   node scripts/make-sample-sheets.mjs [--out <dir>]
 *
 * Files land in docs/samples/ by default. They are generated rather than
 * committed as binaries so the fixtures can be read and edited as code — an
 * .xlsx in git is a blob nobody can review.
 *
 * The sheets are deliberately imperfect. A clean fixture only proves the happy
 * path; these carry the things real shop lists actually contain — units in the
 * header, thousands separators, blank rows, a lot of many pieces, and a few
 * genuine mistakes that the preview must catch and explain.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import * as XLSX from 'xlsx';

const outArg = process.argv.indexOf('--out');
const OUT = outArg > -1 ? resolve(process.argv[outArg + 1]) : resolve('docs/samples');
mkdirSync(OUT, { recursive: true });

const written = [];

function writeSheets(filename, sheets) {
  const wb = XLSX.utils.book_new();
  for (const [name, rows] of Object.entries(sheets)) {
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), name);
  }
  const path = join(OUT, filename);
  writeFileSync(path, XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }));
  written.push(path);
}

function writeCsv(filename, rows) {
  // Quote any cell containing a comma or quote, per RFC 4180.
  const body = rows
    .map((r) =>
      r
        .map((c) => {
          const s = String(c);
          return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
        })
        .join(','),
    )
    .join('\r\n');
  const path = join(OUT, filename);
  writeFileSync(path, `${body}\r\n`, 'utf8');
  written.push(path);
}

// ---------------------------------------------------------------------------
// 1. A typical shop stock list. Headers as a shopkeeper writes them, weights in
//    grams, money with thousands separators, one blank row in the middle.
// ---------------------------------------------------------------------------
writeSheets('1-typical-stock.xlsx', {
  Stock: [
    ['Tag No.', 'Particulars', 'Category', 'Purity', 'Gross Wt (gms)', 'Net Wt (gms)', 'Making /gm', 'Wastage %', 'Qty', 'Remarks'],
    ['R-101', 'Ladies Ring Zircon', 'Ring', '22K', '4.250', '3.900', '1,200', '8', '1', 'showcase 2'],
    ['R-102', 'Gents Ring Plain', 'Ring', '22K', '8.500', '8.500', '1,000', '6', '1', ''],
    ['N-204', 'Bridal Set Heavy', 'Necklace / Set', '21K', '85.500', '78.250', '1,500', '10', '1', 'locker'],
    ['C-310', 'Gents Chain', 'Chain', '22K', '32.000', '32.000', '900', '5', '1', ''],
    ['', '', '', '', '', '', '', '', '', ''],
    ['E-455', 'Jhumka Pair Kundan', 'Earrings / Jhumka', '21K', '18.750', '16.200', '1,800', '12', '1', ''],
    ['B-500', 'Silver Payal Pairs', 'Payal', 'Silver 925', '45.000', '45.000', '150', '0', '6', 'bulk lot'],
    ['L-610', 'Locket Small', 'Locket / Pendant', '18K', '3.200', '2.900', '2,000', '10', '1', ''],
    ['K-720', 'Kangan Pair', 'Bangle / Kangan', '22K', '52.400', '52.400', '1,100', '7', '2', ''],
    ['T-800', 'Coin 1 Tola', 'Coin / Bar', '24K / 999', '11.664', '11.664', '0', '0', '1', 'sealed'],
  ],
});

// ---------------------------------------------------------------------------
// 2. Names only. The point of the flexible importer: a shop whose list is just
//    descriptions, with weights still on paper.
// ---------------------------------------------------------------------------
writeSheets('2-names-only.xlsx', {
  Items: [
    ['Item Name'],
    ['Gold Ring Ladies'],
    ['Gold Ring Gents'],
    ['Bridal Set 21K'],
    ['Silver Payal'],
    ['Kids Bangle Pair'],
    ['Nose Pin Small'],
  ],
});

// ---------------------------------------------------------------------------
// 3. Names and prices — a column the importer has no field for. It must be
//    ignored without complaint rather than blocking the import.
// ---------------------------------------------------------------------------
writeSheets('3-names-and-prices.xlsx', {
  'Price List': [
    ['Particulars', 'Sale Price', 'Remarks'],
    ['Ladies Ring Zircon', '45,000', 'display'],
    ['Gents Kara Heavy', '185,000', ''],
    ['Bridal Set Full', '1,250,000', 'order only'],
    ['Silver Chain', '4,500', ''],
  ],
});

// ---------------------------------------------------------------------------
// 4. Weights kept in tola, as many older shops do. Import with the sheet unit
//    set to Tola; 1 tola must come through as 11.664 g.
// ---------------------------------------------------------------------------
writeSheets('4-weights-in-tola.xlsx', {
  Stock: [
    ['Tag', 'Item', 'Type', 'Purity', 'Gross Wt', 'Net Wt'],
    ['TL-1', 'Coin One Tola', 'Coin / Bar', '24K / 999', '1', '1'],
    ['TL-2', 'Coin Half Tola', 'Coin / Bar', '24K / 999', '0.5', '0.5'],
    ['TL-3', 'Kara Heavy', 'Bangle / Kangan', '22K', '4.5', '4.5'],
    ['TL-4', 'Chain Long', 'Chain', '22K', '2.75', '2.75'],
  ],
});

// ---------------------------------------------------------------------------
// 5. Deliberately broken rows, one per failure mode, each with a good row
//    beside it. Use this to see the preview explain problems — and to confirm
//    that importing with bad rows selected writes NOTHING.
// ---------------------------------------------------------------------------
writeSheets('5-with-mistakes.xlsx', {
  Stock: [
    ['Tag No.', 'Particulars', 'Category', 'Purity', 'Gross Wt (gms)', 'Net Wt (gms)', 'Qty'],
    ['OK-1', 'Perfectly Fine Ring', 'Ring', '22K', '5.000', '4.800', '1'],
    ['BAD-1', 'Net Heavier Than Gross', 'Ring', '22K', '5.000', '6.000', '1'],
    ['BAD-2', 'Unknown Category', 'Spaceship', '22K', '10.000', '10.000', '1'],
    ['BAD-3', 'Unknown Purity', 'Ring', '19K', '5.000', '5.000', '1'],
    // Not actually broken: there is no Metal column in this sheet, so the
    // purity alone decides the metal and the row is valid. Kept as the control
    // case — the "does not belong to metal" error needs BOTH columns present.
    ['BAD-4', 'Purity Names The Metal', 'Ring', '22K / 916', '5.000', '5.000', '1'],
    ['BAD-5', 'Weight Is A Typo', 'Ring', '22K', 'abc', '', '1'],
    ['DUP-9', 'Duplicate Tag One', 'Ring', '22K', '5.000', '5.000', '1'],
    ['DUP-9', 'Duplicate Tag Two', 'Ring', '22K', '6.000', '6.000', '1'],
    ['', 'No Name Row Below', 'Ring', '22K', '5.000', '5.000', '1'],
    ['NO-NAME', '', 'Ring', '22K', '5.000', '5.000', '1'],
    ['OK-2', 'Also Perfectly Fine', 'Chain', '21K', '12.000', '12.000', '1'],
  ],
  // A separate sheet, because this error needs a Metal column that the main
  // sheet does not have: a gold purity filed under Silver.
  'Metal Clash': [
    ['Tag No.', 'Particulars', 'Metal', 'Purity', 'Gross Wt (gms)'],
    ['MC-1', 'Gold Purity Filed As Silver', 'Silver', '22K / 916', '5.000'],
    ['MC-2', 'Correctly Filed', 'Gold', '22K / 916', '5.000'],
  ],
});
// BAD-4's metal column is absent, so the purity decides the metal and the row
// is actually valid — kept as a reminder that the "does not belong" error needs
// BOTH columns present to fire. Fix the fixture note rather than the app if
// this ever changes.

// ---------------------------------------------------------------------------
// 6. A workbook with several sheets, so the sheet picker has something to pick.
// ---------------------------------------------------------------------------
writeSheets('6-multiple-sheets.xlsx', {
  Gold: [
    ['Tag', 'Item', 'Type', 'Purity', 'Gross Wt', 'Net Wt'],
    ['G-1', 'Gold Ring', 'Ring', '22K', '5.000', '4.800'],
    ['G-2', 'Gold Chain', 'Chain', '22K', '20.000', '20.000'],
  ],
  Silver: [
    ['Tag', 'Item', 'Type', 'Purity', 'Gross Wt', 'Net Wt'],
    ['S-1', 'Silver Payal', 'Payal', 'Silver 925', '40.000', '40.000'],
    ['S-2', 'Silver Ring', 'Ring', 'Silver 925', '6.000', '6.000'],
  ],
  Notes: [['This sheet is not a stock list'], ['It is here so the sheet picker has a wrong choice too']],
});

// ---------------------------------------------------------------------------
// 7. Odd headers nothing will auto-match, for exercising "Check columns".
// ---------------------------------------------------------------------------
writeSheets('7-unknown-headers.xlsx', {
  Sheet1: [
    ['Col A', 'Col B', 'Col C'],
    ['Ring Ladies 22K', '5.250', 'Ring'],
    ['Chain Gents 22K', '30.000', 'Chain'],
    ['Payal Silver', '45.000', 'Payal'],
  ],
});

// ---------------------------------------------------------------------------
// 8. The same data as CSV, to prove both formats read identically.
// ---------------------------------------------------------------------------
writeCsv('8-typical-stock.csv', [
  ['Tag No.', 'Particulars', 'Category', 'Purity', 'Gross Wt (gms)', 'Net Wt (gms)', 'Making /gm', 'Qty'],
  ['CSV-1', 'Ladies Ring Zircon', 'Ring', '22K', '4.250', '3.900', '1,200', '1'],
  ['CSV-2', 'Gents Chain', 'Chain', '22K', '32.000', '32.000', '900', '1'],
  ['CSV-3', 'Silver Payal Pairs', 'Payal', 'Silver 925', '45.000', '45.000', '150', '6'],
]);

console.log(`Wrote ${written.length} sample files to ${OUT}:`);
for (const p of written) console.log(`  ${p}`);
