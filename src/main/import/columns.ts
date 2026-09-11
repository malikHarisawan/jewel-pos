/**
 * Column recognition and value parsing.
 *
 * A shop's existing sheet was written for humans, not for us: headers read
 * "Wt (gms)", "Gross Weight", "MAKING/GM". So headers are matched by a
 * normalised alias list rather than by exact text, and the mapping is returned
 * to the UI so the shopkeeper can correct any column we guessed wrong.
 *
 * Every parser here is total: it returns a value or an error string, never
 * throws. A single bad cell must produce one readable row error, not a crash
 * that loses the other 400 rows.
 */

/** Lowercase, strip everything that isn't a letter or digit. "Gross Wt. (g)"
 * and "gross_wt_g" both collapse to "grosswtg" — close enough that a short
 * alias list covers the real variety. */
export function normalizeHeader(h: string): string {
  return h.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * A header with any trailing unit noise removed: "Gross Wt (gms)" and
 * "Net Weight in grams" reduce to "grosswt" and "netweight".
 *
 * Shops label the unit in the header far more often than in a column of its
 * own, and every combination of gm/gms/gram/grams/tola/mg — bracketed, after
 * "in", or just appended — would otherwise need its own alias. Stripping the
 * suffix once here keeps the alias lists to the names people actually use.
 */
export function stripUnitSuffix(normalized: string): string {
  return normalized.replace(/(?:in)?(?:gms|gm|grams|gram|g|tola|tolas|mg|kg)$/, '');
}

/** The fields an item sheet can supply. `required` drives the preview's
 * "this column is missing" warning. */
export interface FieldDef {
  key: string;
  label: string;
  required: boolean;
  aliases: readonly string[];
}

export const ITEM_FIELDS: readonly FieldDef[] = [
  {
    key: 'tagNumber',
    label: 'Tag number',
    required: false,
    aliases: ['tag', 'tagno', 'tagnumber', 'code', 'itemcode', 'sku', 'barcode', 'articleno'],
  },
  {
    key: 'name',
    label: 'Item name',
    required: true,
    aliases: ['name', 'itemname', 'item', 'description', 'particulars', 'product', 'productname'],
  },
  {
    key: 'productType',
    label: 'Product type',
    required: false,
    aliases: ['type', 'producttype', 'category', 'itemtype', 'design'],
  },
  {
    key: 'metal',
    label: 'Metal',
    required: false,
    aliases: ['metal', 'metaltype'],
  },
  {
    key: 'purity',
    label: 'Purity',
    required: false,
    aliases: ['purity', 'karat', 'carat', 'kt', 'k', 'quality', 'fineness'],
  },
  {
    key: 'stoneType',
    label: 'Stone',
    required: false,
    aliases: ['stone', 'stonetype', 'stones'],
  },
  {
    key: 'makingType',
    label: 'Making type',
    required: false,
    aliases: ['makingtype', 'workmanship', 'craft', 'maketype'],
  },
  {
    key: 'occasion',
    label: 'Occasion',
    required: false,
    aliases: ['occasion', 'usage', 'wear'],
  },
  {
    key: 'grossWeight',
    label: 'Gross weight',
    // Not required. A shop's sheet is often just a name list, or a name plus a
    // price, with weights still on paper. Refusing those files would mean the
    // importer only works for shops that least need it — so a row with no
    // weight imports at zero and is finished by hand later.
    required: false,
    aliases: [
      'gross', 'grosswt', 'grossweight', 'grossweightg', 'grosswtg', 'grossgm', 'grossgms',
      'weight', 'wt', 'wtgms', 'wtg', 'weightg', 'weightgms', 'gwt',
    ],
  },
  {
    key: 'lessWeight',
    label: 'Less weight',
    required: false,
    aliases: ['less', 'lesswt', 'lessweight', 'stonewt', 'stoneweight', 'deduction', 'lesswtg'],
  },
  {
    key: 'netWeight',
    label: 'Net weight',
    required: false,
    aliases: ['net', 'netwt', 'netweight', 'netweightg', 'netwtg', 'netgm', 'netgms', 'nwt'],
  },
  {
    key: 'weightUnit',
    label: 'Weight unit',
    required: false,
    aliases: ['unit', 'weightunit', 'wtunit', 'uom'],
  },
  {
    key: 'touch',
    label: 'Touch %',
    required: false,
    aliases: ['touch', 'touchpct', 'touchpercent', 'tunch'],
  },
  {
    key: 'wastage',
    label: 'Wastage %',
    required: false,
    aliases: ['wastage', 'waste', 'wastagepct', 'wastagepercent', 'wst'],
  },
  {
    key: 'makingMode',
    label: 'Making basis',
    required: false,
    aliases: ['makingmode', 'makingbasis', 'labourmode', 'makingchargetype'],
  },
  {
    key: 'makingRate',
    label: 'Making rate',
    required: false,
    aliases: [
      'making', 'makingrate', 'makingcharge', 'makingcharges', 'labour', 'labor',
      'labourcharge', 'majoori', 'mazdoori', 'makingpergram', 'makinggm',
    ],
  },
  {
    key: 'hallmarkNumber',
    label: 'Hallmark no.',
    required: false,
    aliases: ['hallmark', 'hallmarkno', 'hallmarknumber', 'huid'],
  },
  {
    key: 'hallmarkCharge',
    label: 'Hallmark charge',
    required: false,
    aliases: ['hallmarkcharge', 'hallmarkfee', 'hmcharge'],
  },
  {
    key: 'pieces',
    label: 'Pieces',
    required: false,
    aliases: ['pieces', 'pcs', 'qty', 'quantity', 'nos', 'count'],
  },
  {
    key: 'location',
    label: 'Location',
    required: false,
    aliases: ['location', 'branch', 'counter', 'showcase', 'tray', 'shelf'],
  },
  {
    key: 'notes',
    label: 'Notes',
    required: false,
    aliases: ['notes', 'remarks', 'remark', 'comment', 'comments'],
  },
];

/**
 * Guess which spreadsheet column feeds which field.
 *
 * Exact alias match only — no fuzzy scoring. A wrong guess that silently loads
 * "stone weight" into "net weight" corrupts the shop's books and the operator
 * has no way to notice. Leaving it unmapped makes them pick, which is the
 * safer failure.
 *
 * Returns `field key -> header text`. Headers we don't recognise are simply
 * absent, and the UI lets the user attach them by hand.
 */
export function guessMapping(headers: readonly string[]): Record<string, string> {
  const used = new Set<string>();
  const mapping: Record<string, string> = {};

  // Two passes. An exact alias match is preferred everywhere before any
  // unit-stripped match is considered — otherwise a "Net Wt" column could lose
  // out to a "Weight (gms)" column that only matches after stripping.
  const match = (field: FieldDef, transform: (n: string) => string): string | undefined =>
    headers.find((h) => {
      if (used.has(h)) return false;
      const n = transform(normalizeHeader(h));
      return n !== '' && field.aliases.includes(n);
    });

  for (const pass of [(n: string) => n, stripUnitSuffix]) {
    for (const field of ITEM_FIELDS) {
      if (mapping[field.key]) continue;
      const hit = match(field, pass);
      if (hit) {
        mapping[field.key] = hit;
        used.add(hit);
      }
    }
  }
  return mapping;
}

// ---- value parsers --------------------------------------------------------

/** Ok/err without exceptions, so one bad cell yields one row error. */
export type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

const ok = <T>(value: T): Parsed<T> => ({ ok: true, value });
const err = (error: string): Parsed<never> => ({ ok: false, error });

/**
 * Parse a number a shopkeeper typed.
 *
 * Handles thousands separators, a trailing unit ("12.5 g", "8%"), currency
 * marks, and parenthesised negatives from accounting exports. Rejects anything
 * still ambiguous rather than guessing — "12,5" is 125 under one reading and
 * 12.5 under another, and silently picking one falsifies a weight.
 */
export function parseNumber(raw: string): Parsed<number> {
  const s = raw.trim();
  if (s === '') return err('empty');

  const negative = /^\(.*\)$/.test(s);
  let body = negative ? s.slice(1, -1) : s;

  // Drop currency symbols, unit suffixes and percent signs.
  body = body
    .replace(/(?:rs\.?|pkr|rupees?)/gi, '')
    .replace(/%/g, '')
    .replace(/\b(?:gms?|grams?|gm|g|tola|tolas|mg|kg|ct|carats?)\b/gi, '')
    .trim();

  // Thousands separators: strip commas only when they sit in grouping
  // positions ("1,234,567.89"). A lone "12,5" is a decimal comma under one
  // convention and grouping under another — refuse it.
  if (body.includes(',')) {
    if (/^-?\d{1,3}(,\d{3})*(\.\d+)?$/.test(body)) {
      body = body.replace(/,/g, '');
    } else if (/^-?\d+,\d+$/.test(body)) {
      return err(`ambiguous number "${raw}" — use a dot for decimals`);
    } else {
      return err(`not a number: "${raw}"`);
    }
  }

  if (!/^-?\d*\.?\d+$/.test(body)) return err(`not a number: "${raw}"`);
  const n = Number(body);
  if (!Number.isFinite(n)) return err(`not a number: "${raw}"`);
  return ok(negative ? -n : n);
}

export type SheetWeightUnit = 'g' | 'mg' | 'tola';

/** Which unit a weight column is in. Defaults to grams: shop sheets list grams
 * unless they say otherwise. */
export function parseWeightUnit(raw: string): SheetWeightUnit {
  const n = normalizeHeader(raw);
  if (n === 'tola' || n === 'tolas' || n === 'tl') return 'tola';
  if (n === 'mg' || n === 'milligram' || n === 'milligrams') return 'mg';
  return 'g';
}

/**
 * A weight cell to integer milligrams — the only weight unit the database
 * stores. Rounds to the nearest mg; a sheet carrying more precision than a
 * milligram is recording scale noise, not real weight.
 */
export function parseWeightMg(raw: string, unit: SheetWeightUnit, tolaMg: number): Parsed<number> {
  const n = parseNumber(raw);
  if (!n.ok) return n;
  if (n.value < 0) return err('weight cannot be negative');
  const mg = unit === 'mg' ? n.value : unit === 'tola' ? n.value * tolaMg : n.value * 1000;
  return ok(Math.round(mg));
}

/** A money cell to integer paisa. Sheets are written in rupees. */
export function parseMoneyPaisa(raw: string): Parsed<number> {
  const n = parseNumber(raw);
  if (!n.ok) return n;
  if (n.value < 0) return err('amount cannot be negative');
  return ok(Math.round(n.value * 100));
}

/**
 * A percentage cell to basis points. Accepts "8", "8%", "0.08%" — but a bare
 * "0.08" is read as 0.08%, not as the fraction 8%. Treating fractions and
 * percents as the same input would make 12% wastage indistinguishable from
 * 0.12%, so the sheet's number is always a literal percentage.
 */
export function parsePercentBp(raw: string): Parsed<number> {
  const n = parseNumber(raw);
  if (!n.ok) return n;
  if (n.value < 0) return err('percentage cannot be negative');
  if (n.value > 100) return err(`percentage above 100: "${raw}"`);
  return ok(Math.round(n.value * 100));
}

/** An integer count (pieces). */
export function parseCount(raw: string): Parsed<number> {
  const n = parseNumber(raw);
  if (!n.ok) return n;
  if (!Number.isInteger(n.value)) return err(`must be a whole number: "${raw}"`);
  if (n.value < 0) return err('cannot be negative');
  return ok(n.value);
}

/** Making basis words a sheet might use. */
export function parseMakingMode(raw: string): Parsed<'PER_GRAM' | 'FIXED' | 'PCT_OF_METAL'> {
  const n = normalizeHeader(raw);
  if (n === '') return ok('PER_GRAM');
  if (['pergram', 'pergm', 'gram', 'gm', 'perg', 'rategram'].includes(n)) return ok('PER_GRAM');
  if (['fixed', 'flat', 'lumpsum', 'fixedamount', 'perpiece', 'piece'].includes(n)) return ok('FIXED');
  if (['pct', 'percent', 'percentage', 'pctofmetal', 'ofmetal', 'onmetal'].includes(n))
    return ok('PCT_OF_METAL');
  return err(`unknown making basis "${raw}" (use per gram, fixed or percent)`);
}
