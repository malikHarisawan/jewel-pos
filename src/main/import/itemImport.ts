/**
 * Item import — turning a shop's spreadsheet into validated `items` rows.
 *
 * Two phases, deliberately separate:
 *
 *   analyse()  reads the file, maps columns, validates every row and reports
 *              what WOULD happen. Touches nothing.
 *   commit()   re-validates and writes, inside one transaction.
 *
 * The re-validation in commit() is not redundant. The preview the user approved
 * was computed from a file and a database that may both have moved since; the
 * only validation that can be trusted is the one running in the same
 * transaction as the insert.
 *
 * All-or-nothing is the rule: if any selected row fails, the whole import rolls
 * back. A half-loaded inventory is worse than none — the shopkeeper cannot tell
 * which half landed, and the natural fix (import again) silently duplicates
 * everything that succeeded the first time.
 */
import type { DB } from '../db/connection.js';
import { withAudit } from '../db/audit.js';
import { insertMovement } from '../services/ledgerService.js';
import { readWorkbook, gridToRecords } from './sheet.js';
import {
  ITEM_FIELDS,
  guessMapping,
  normalizeHeader,
  parseCount,
  parseMakingMode,
  parseMoneyPaisa,
  parsePercentBp,
  parseWeightMg,
  parseWeightUnit,
  type SheetWeightUnit,
} from './columns.js';
import { TOLA_MG } from '../../shared/units/index.js';

/** How many rows a single import may carry. Well past any real shop's opening
 * stock, and low enough that a mistakenly-picked 2 GB export is refused before
 * it is parsed into memory rather than after. */
export const MAX_IMPORT_ROWS = 5000;

// ---- catalog lookup -------------------------------------------------------

interface Lookup {
  /** normalised name -> id */
  byName: Map<string, number>;
  /** id -> the name as the app spells it. The preview shows what a row will
   * BECOME, so it needs the app's own label ("22K / 916"), not the sheet's
   * shorthand ("22") — that is what makes a wrong match visible. */
  nameById: Map<number, string>;
  /** id of the row used when the sheet leaves the column blank */
  defaultId: number | null;
  /** for error messages */
  label: string;
  options: string[];
}

/**
 * Build a name -> id index for one lookup table.
 *
 * `locations` is an adjacency list and carries no `sort_order`, unlike the
 * category axes, so the ordering column is a parameter rather than assumed.
 * Order matters beyond tidiness: the first row becomes the default used when
 * the sheet leaves that column blank.
 */
function buildLookup(
  db: DB,
  table: string,
  label: string,
  orderBy = 'sort_order, id',
): Lookup {
  const rows = db
    .prepare(`SELECT id, name FROM ${table} WHERE is_active=1 ORDER BY ${orderBy}`)
    .all() as Array<{ id: number; name: string }>;
  const byName = new Map<string, number>();
  const nameById = new Map<number, string>();
  for (const r of rows) {
    nameById.set(r.id, r.name);
    const key = normalizeHeader(r.name);
    if (key && !byName.has(key)) byName.set(key, r.id);
  }
  return {
    byName,
    nameById,
    defaultId: rows.length > 0 ? rows[0].id : null,
    label,
    options: rows.map((r) => r.name),
  };
}

/**
 * Purity is matched loosely because shops write it every possible way: "22",
 * "22K", "22 kt", "916", "22K / 916". Both the karat number and the fineness
 * are indexed, on top of the full label.
 */
function buildPurityLookup(db: DB): Lookup & { metalOf: Map<number, number> } {
  const rows = db
    .prepare(
      `SELECT id, metal_id, label, fineness_millesimal
       FROM purities WHERE is_active=1 ORDER BY metal_id, sort_order`,
    )
    .all() as Array<{
    id: number;
    metal_id: number;
    label: string;
    fineness_millesimal: number;
  }>;

  const byName = new Map<string, number>();
  const nameById = new Map<number, string>();
  const metalOf = new Map<number, number>();
  const add = (key: string, id: number) => {
    const k = normalizeHeader(key);
    if (k && !byName.has(k)) byName.set(k, id);
  };

  for (const r of rows) {
    metalOf.set(r.id, r.metal_id);
    nameById.set(r.id, r.label);
    add(r.label, r.id);
    add(String(r.fineness_millesimal), r.id);
    // "22K / 916" -> also index "22k" and "22".
    const karat = /(\d{1,2})\s*k/i.exec(r.label);
    if (karat) {
      add(`${karat[1]}k`, r.id);
      add(karat[1], r.id);
    }
    // "Silver 925" -> "silver925" is already covered by the label; also index
    // the bare number, done above via fineness.
  }

  return {
    byName,
    nameById,
    defaultId: rows.length > 0 ? rows[0].id : null,
    label: 'purity',
    options: rows.map((r) => r.label),
    metalOf,
  };
}

interface Catalogs {
  productTypes: Lookup;
  metals: Lookup;
  purities: ReturnType<typeof buildPurityLookup>;
  stoneTypes: Lookup;
  makingTypes: Lookup;
  occasions: Lookup;
  locations: Lookup;
  tolaMg: number;
}

function loadCatalogs(db: DB): Catalogs {
  const tolaRow = db
    .prepare(`SELECT value FROM app_settings WHERE key='tola_mg'`)
    .get() as { value: string } | undefined;
  const tolaMg = tolaRow ? Number(tolaRow.value) : TOLA_MG;

  return {
    productTypes: buildLookup(db, 'product_types', 'product type'),
    metals: buildLookup(db, 'metals', 'metal'),
    purities: buildPurityLookup(db),
    stoneTypes: buildLookup(db, 'stone_types', 'stone type'),
    makingTypes: buildLookup(db, 'making_types', 'making type'),
    occasions: buildLookup(db, 'occasions', 'occasion'),
    locations: buildLookup(db, 'locations', 'location', 'id'),
    tolaMg: Number.isFinite(tolaMg) && tolaMg > 0 ? tolaMg : TOLA_MG,
  };
}

// ---- row shapes -----------------------------------------------------------

/** A row that passed validation, ready to insert. */
export interface PreparedRow {
  trackingMode: 'ITEM' | 'LOT';
  tagNumber: string | null;
  name: string;
  productTypeId: number;
  metalId: number;
  purityId: number;
  stoneTypeId: number;
  makingTypeId: number;
  occasionId: number | null;
  grossMg: number;
  lessMg: number;
  netMg: number;
  touchBp: number | null;
  wastageBp: number;
  makingMode: 'PER_GRAM' | 'FIXED' | 'PCT_OF_METAL';
  makingRatePaisa: number;
  hallmarkNumber: string | null;
  hallmarkChargePaisa: number;
  locationId: number;
  notes: string | null;
  openingPieces: number;
  /** What the shop paid per gram. Null when the sheet did not say. */
  intakeRatePaisaPerGram: number | null;
  labourPaidPaisa: number;
}

export interface RowResult {
  /** 1-based row number as it appears in the spreadsheet (header is row 1). */
  rowNumber: number;
  ok: boolean;
  /** Blocking problems. Non-empty means the row cannot be imported. */
  errors: string[];
  /** Non-blocking notes: a guessed default, a derived weight. */
  warnings: string[];
  /** What the row will become. Null when it failed. */
  prepared: PreparedRow | null;
  /**
   * The row rendered the way the Items screen renders an item — resolved names
   * and integer weights, not the sheet's raw text. Showing "22K / 916" rather
   * than the cell's "22" is what lets a wrong match be spotted before import.
   *
   * Values are null when the row failed before that field could be worked out.
   */
  preview: ItemPreview;
}

/** The Items-screen view of a row that has not been imported yet. */
export interface ItemPreview {
  /** Blank when the sheet gave no tag — one is allocated at import time. */
  tag: string;
  name: string;
  trackingMode: 'ITEM' | 'LOT' | null;
  productType: string | null;
  metal: string | null;
  purity: string | null;
  location: string | null;
  grossMg: number | null;
  lessMg: number | null;
  netMg: number | null;
  pieces: number | null;
  makingMode: 'PER_GRAM' | 'FIXED' | 'PCT_OF_METAL' | null;
  makingRatePaisa: number | null;
  wastageBp: number | null;
}

export interface AnalyseResult {
  sheetNames: string[];
  sheetName: string;
  headers: string[];
  /** field key -> chosen header. What the UI shows and lets the user edit. */
  mapping: Record<string, string>;
  /** Field keys that are required and had no column. */
  missingRequired: string[];
  rows: RowResult[];
  totalRows: number;
  okRows: number;
  errorRows: number;
}

// ---- validation -----------------------------------------------------------

/** Resolve a category cell to an id, falling back to the catalog default. */
function resolveAxis(
  raw: string,
  lookup: Lookup,
  errors: string[],
  optional = false,
): number | null {
  const text = raw.trim();
  if (text === '') {
    if (optional) return null;
    if (lookup.defaultId === null) {
      errors.push(`no ${lookup.label} is set up in the app`);
      return null;
    }
    // Silent: a blank optional-ish column is normal, and one warning per row
    // for every unfilled column would drown the real problems.
    return lookup.defaultId;
  }
  const id = lookup.byName.get(normalizeHeader(text));
  if (id === undefined) {
    const known = lookup.options.slice(0, 8).join(', ');
    errors.push(`unknown ${lookup.label} "${text}" (known: ${known})`);
    return null;
  }
  return id;
}

/**
 * Validate one spreadsheet record.
 *
 * Weight is the fiddly part. A sheet may give gross only, gross + net, gross +
 * less, or all three. The database requires net = gross - less exactly, so
 * whichever pair is present derives the third, and all three present must
 * agree.
 */
function prepareRow(
  rec: Record<string, string>,
  rowNumber: number,
  mapping: Record<string, string>,
  cat: Catalogs,
  sheetUnit: SheetWeightUnit,
): RowResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const cell = (field: string): string => {
    const header = mapping[field];
    return header ? (rec[header] ?? '').trim() : '';
  };

  const name = cell('name');
  if (name === '') errors.push('item name is empty');

  // Per-row unit override, if the sheet carries a unit column.
  const unitCell = cell('weightUnit');
  const unit = unitCell ? parseWeightUnit(unitCell) : sheetUnit;

  // ---- weights
  const grossRaw = cell('grossWeight');
  const lessRaw = cell('lessWeight');
  const netRaw = cell('netWeight');

  let grossMg: number | null = null;
  let lessMg: number | null = null;
  let netMg: number | null = null;

  const weight = (raw: string, label: string): number | null => {
    const p = parseWeightMg(raw, unit, cat.tolaMg);
    if (!p.ok) {
      errors.push(`${label}: ${p.error}`);
      return null;
    }
    return p.value;
  };

  if (grossRaw !== '') grossMg = weight(grossRaw, 'gross weight');
  if (lessRaw !== '') lessMg = weight(lessRaw, 'less weight');
  if (netRaw !== '') netMg = weight(netRaw, 'net weight');

  if (grossMg === null && netMg === null) {
    // A blank weight is a gap to fill in later, not a broken row: plenty of
    // shop lists carry only names and prices. It imports at zero and is
    // flagged so the owner can weigh the piece and edit it.
    //
    // A weight that was present but unreadable is different — that already
    // pushed a parse error above, and silently zeroing it would turn a typo
    // into a wrong weight on the shelf.
    if (grossRaw === '' && netRaw === '') {
      grossMg = 0;
      lessMg = 0;
      netMg = 0;
      warnings.push('no weight in the file — imported as 0, set it before selling');
    }
  } else if (grossMg === null && netMg !== null) {
    // Net only: nothing was deducted as far as the sheet is concerned.
    grossMg = netMg + (lessMg ?? 0);
    warnings.push('gross weight derived from net');
  } else if (grossMg !== null && netMg === null) {
    lessMg = lessMg ?? 0;
    netMg = grossMg - lessMg;
  } else if (grossMg !== null && netMg !== null) {
    const derived = grossMg - netMg;
    if (lessMg === null) {
      lessMg = derived;
    } else if (lessMg !== derived) {
      errors.push(
        `weights do not add up: gross ${grossMg}mg - less ${lessMg}mg is not net ${netMg}mg`,
      );
    }
  }

  if (grossMg !== null && netMg !== null && netMg > grossMg) {
    errors.push('net weight is greater than gross weight');
  }
  if (lessMg !== null && lessMg < 0) errors.push('less weight is negative');

  // ---- categories
  const productTypeId = resolveAxis(cell('productType'), cat.productTypes, errors);
  const metalCell = cell('metal');
  const metalId = resolveAxis(metalCell, cat.metals, errors);
  const stoneTypeId = resolveAxis(cell('stoneType'), cat.stoneTypes, errors);
  const makingTypeId = resolveAxis(cell('makingType'), cat.makingTypes, errors);
  const occasionId = resolveAxis(cell('occasion'), cat.occasions, errors, true);
  const locationId = resolveAxis(cell('location'), cat.locations, errors);

  // Purity carries its own metal. A conflict is only a conflict when the sheet
  // actually NAMED a metal — with no Metal column the purity simply decides,
  // which is the ordinary case and needs no warning: the preview shows the
  // resolved metal, and warnings that fire on normal rows train the reader to
  // skim past the ones that matter.
  const purityId = resolveAxis(cell('purity'), cat.purities, errors);
  if (purityId !== null && metalId !== null && metalCell !== '') {
    const purityMetal = cat.purities.metalOf.get(purityId);
    if (purityMetal !== undefined && purityMetal !== metalId) {
      errors.push(`purity "${cell('purity')}" does not belong to metal "${metalCell}"`);
    }
  }

  // ---- numbers
  const touchRaw = cell('touch');
  let touchBp: number | null = null;
  if (touchRaw !== '') {
    const p = parsePercentBp(touchRaw);
    if (!p.ok) errors.push(`touch: ${p.error}`);
    else if (p.value < 1) errors.push('touch must be above 0%');
    else touchBp = p.value;
  }

  const wastageRaw = cell('wastage');
  let wastageBp = 0;
  if (wastageRaw !== '') {
    const p = parsePercentBp(wastageRaw);
    if (!p.ok) errors.push(`wastage: ${p.error}`);
    else wastageBp = p.value;
  }

  const makingModeRaw = cell('makingMode');
  let makingMode: PreparedRow['makingMode'] = 'PER_GRAM';
  {
    const p = parseMakingMode(makingModeRaw);
    if (!p.ok) errors.push(p.error);
    else makingMode = p.value;
  }

  const makingRaw = cell('makingRate');
  let makingRatePaisa = 0;
  if (makingRaw !== '') {
    if (makingMode === 'PCT_OF_METAL') {
      // A percentage making charge is stored in basis points, not paisa.
      const p = parsePercentBp(makingRaw);
      if (!p.ok) errors.push(`making rate: ${p.error}`);
      else makingRatePaisa = p.value;
    } else {
      const p = parseMoneyPaisa(makingRaw);
      if (!p.ok) errors.push(`making rate: ${p.error}`);
      else makingRatePaisa = p.value;
    }
  }

  const hallmarkChargeRaw = cell('hallmarkCharge');
  let hallmarkChargePaisa = 0;
  if (hallmarkChargeRaw !== '') {
    const p = parseMoneyPaisa(hallmarkChargeRaw);
    if (!p.ok) errors.push(`hallmark charge: ${p.error}`);
    else hallmarkChargePaisa = p.value;
  }

  /* Purchase cost. Optional everywhere: a sheet that does not carry it imports
     fine and the profit report says the metal movement is unknown for those
     pieces, which is the honest answer. A zero is treated as "not supplied"
     rather than "bought free" — the latter would report the whole sale price
     as profit. */
  const intakeRateRaw = cell('intakeRate');
  let intakeRatePaisaPerGram: number | null = null;
  if (intakeRateRaw !== '') {
    const p = parseMoneyPaisa(intakeRateRaw);
    if (!p.ok) errors.push(`purchase rate: ${p.error}`);
    else if (p.value > 0) intakeRatePaisaPerGram = p.value;
  }

  const labourPaidRaw = cell('labourPaid');
  let labourPaidPaisa = 0;
  if (labourPaidRaw !== '') {
    const p = parseMoneyPaisa(labourPaidRaw);
    if (!p.ok) errors.push(`labour paid: ${p.error}`);
    else labourPaidPaisa = p.value;
  }

  const piecesRaw = cell('pieces');
  let pieces = 1;
  if (piecesRaw !== '') {
    const p = parseCount(piecesRaw);
    if (!p.ok) errors.push(`pieces: ${p.error}`);
    else pieces = p.value;
  }

  // Tracking mode follows the piece count. One piece is a tagged item; several
  // of one description is a lot, which is exactly how the schema splits them.
  const trackingMode: PreparedRow['trackingMode'] = pieces > 1 ? 'LOT' : 'ITEM';

  const tagRaw = cell('tagNumber');
  // RAW-/SCRAP- are reserved for internal karigar and old-gold lots, which the
  // item screens filter out. A tag in that space would import an item that is
  // then invisible in the list.
  if (/^(RAW|SCRAP)-/i.test(tagRaw)) {
    errors.push(`tag "${tagRaw}" uses a reserved prefix (RAW- / SCRAP-)`);
  }

  // The purity's own metal wins over the metal column: pricing keys on purity,
  // so an item filed under a different metal than its purity implies would be
  // inconsistent. Worked out here, before the preview, so the table shows the
  // metal the item will actually carry rather than the one the sheet named.
  const effectiveMetalId =
    purityId !== null ? (cat.purities.metalOf.get(purityId) ?? metalId) : metalId;

  const preview: ItemPreview = {
    tag: tagRaw,
    name,
    trackingMode,
    productType: productTypeId === null ? null : (cat.productTypes.nameById.get(productTypeId) ?? null),
    metal: effectiveMetalId === null ? null : (cat.metals.nameById.get(effectiveMetalId) ?? null),
    purity: purityId === null ? null : (cat.purities.nameById.get(purityId) ?? null),
    location: locationId === null ? null : (cat.locations.nameById.get(locationId) ?? null),
    grossMg,
    lessMg,
    netMg,
    pieces,
    makingMode,
    makingRatePaisa,
    wastageBp,
  };

  if (
    errors.length > 0 ||
    grossMg === null ||
    netMg === null ||
    lessMg === null ||
    productTypeId === null ||
    metalId === null ||
    effectiveMetalId === null ||
    purityId === null ||
    stoneTypeId === null ||
    makingTypeId === null ||
    locationId === null
  ) {
    return { rowNumber, ok: false, errors, warnings, prepared: null, preview };
  }

  return {
    rowNumber,
    ok: true,
    errors,
    warnings,
    preview,
    prepared: {
      trackingMode,
      tagNumber: tagRaw === '' ? null : tagRaw,
      name,
      productTypeId,
      metalId: effectiveMetalId,
      purityId,
      stoneTypeId,
      makingTypeId,
      occasionId,
      grossMg,
      lessMg,
      netMg,
      touchBp,
      wastageBp,
      makingMode,
      makingRatePaisa,
      hallmarkNumber: cell('hallmarkNumber') === '' ? null : cell('hallmarkNumber'),
      hallmarkChargePaisa,
      locationId,
      notes: cell('notes') === '' ? null : cell('notes'),
      openingPieces: pieces,
      intakeRatePaisaPerGram,
      labourPaidPaisa,
    },
  };
}

/**
 * Tag numbers must be unique across the database, and also within the file.
 * Checked as a whole-file pass rather than per row so BOTH sides of a duplicate
 * pair are flagged — telling the user only about the second one sends them
 * hunting for a row they were never shown.
 */
function flagDuplicateTags(db: DB, rows: RowResult[]): void {
  const seen = new Map<string, number[]>();
  for (const r of rows) {
    const tag = r.prepared?.tagNumber;
    if (!tag) continue;
    const key = tag.toLowerCase();
    const list = seen.get(key);
    if (list) list.push(r.rowNumber);
    else seen.set(key, [r.rowNumber]);
  }

  const existsStmt = db.prepare('SELECT 1 FROM items WHERE lower(tag_number) = ? LIMIT 1');

  for (const r of rows) {
    const tag = r.prepared?.tagNumber;
    if (!tag) continue;
    const key = tag.toLowerCase();
    const rowsWithTag = seen.get(key) ?? [];
    if (rowsWithTag.length > 1) {
      const others = rowsWithTag.filter((n) => n !== r.rowNumber);
      r.errors.push(`tag "${tag}" is repeated in this file (also on row ${others.join(', ')})`);
      r.ok = false;
      r.prepared = null;
    } else if (existsStmt.get(key)) {
      r.errors.push(`tag "${tag}" already exists in the shop's inventory`);
      r.ok = false;
      r.prepared = null;
    }
  }
}

// ---- public API -----------------------------------------------------------

export interface AnalyseOptions {
  filePath: string;
  /** Which sheet to read. Defaults to the first. */
  sheetName?: string;
  /** Overrides for the guessed column mapping (field key -> header). */
  mapping?: Record<string, string>;
  /** Unit for weight columns that carry no unit of their own. */
  weightUnit?: SheetWeightUnit;
}

/** Read + validate, writing nothing. This is what fills the preview table. */
export function analyseItemSheet(db: DB, opts: AnalyseOptions): AnalyseResult {
  const wb = readWorkbook(opts.filePath);
  if (wb.names.length === 0) throw new Error('that file has no sheets in it');

  const sheetName = opts.sheetName && wb.names.includes(opts.sheetName)
    ? opts.sheetName
    : wb.names[0];
  const { headers, records } = gridToRecords(wb.sheets[sheetName]);

  if (headers.length === 0) throw new Error(`sheet "${sheetName}" is empty`);
  if (records.length > MAX_IMPORT_ROWS) {
    throw new Error(
      `that sheet has ${records.length} rows; the limit is ${MAX_IMPORT_ROWS} per import`,
    );
  }

  // Start from the guess, then apply the user's corrections. Only overrides
  // naming a real header are honoured — a stale mapping from a previously
  // picked file must not silently read the wrong column.
  const mapping = guessMapping(headers);
  for (const [field, header] of Object.entries(opts.mapping ?? {})) {
    if (header === '') delete mapping[field];
    else if (headers.includes(header)) mapping[field] = header;
  }

  const missingRequired = ITEM_FIELDS.filter((f) => f.required && !mapping[f.key]).map(
    (f) => f.key,
  );

  const cat = loadCatalogs(db);
  const sheetUnit = opts.weightUnit ?? 'g';

  // Row 1 is the header, so the first record is spreadsheet row 2.
  const rows = records.map((rec, i) => prepareRow(rec, i + 2, mapping, cat, sheetUnit));
  flagDuplicateTags(db, rows);

  return {
    sheetNames: wb.names,
    sheetName,
    headers,
    mapping,
    missingRequired,
    rows,
    totalRows: rows.length,
    okRows: rows.filter((r) => r.ok).length,
    errorRows: rows.filter((r) => !r.ok).length,
  };
}

export interface CommitOptions extends AnalyseOptions {
  /** Spreadsheet row numbers to import. Absent means every valid row. */
  rowNumbers?: number[];
  /** Post opening stock movements for the imported pieces. */
  postOpeningStock: boolean;
}

export interface CommitResult {
  imported: number;
  openingMovements: number;
}

/** Next free sequential tag, allocated in-process so a batch of untagged rows
 * doesn't re-read the same maximum for every one of them. */
function tagAllocator(db: DB): () => string {
  const row = db
    .prepare(
      `SELECT tag_number FROM items WHERE tag_number LIKE 'TAG-%'
       ORDER BY id DESC LIMIT 1`,
    )
    .get() as { tag_number: string } | undefined;
  let next = row ? Number(row.tag_number.slice(4)) + 1 : 1;
  if (!Number.isFinite(next)) next = 1;
  return () => `TAG-${String(next++).padStart(6, '0')}`;
}

/**
 * Write the import. Re-analyses first, then inserts inside one transaction —
 * so a row that went stale between preview and confirm aborts the whole batch
 * rather than landing half of it.
 */
export function commitItemImport(
  db: DB,
  userId: number,
  opts: CommitOptions,
): CommitResult {
  const analysis = analyseItemSheet(db, opts);

  const wanted = opts.rowNumbers ? new Set(opts.rowNumbers) : null;
  const chosen = analysis.rows.filter((r) => (wanted ? wanted.has(r.rowNumber) : true));

  const broken = chosen.filter((r) => !r.ok);
  if (broken.length > 0) {
    const sample = broken
      .slice(0, 5)
      .map((r) => `row ${r.rowNumber}: ${r.errors[0]}`)
      .join('; ');
    throw new Error(
      `${broken.length} of the selected rows are not valid, so nothing was imported — ${sample}` +
        (broken.length > 5 ? ' …' : ''),
    );
  }
  if (chosen.length === 0) throw new Error('no rows were selected to import');

  // withAudit runs the body in a transaction, so any throw below rolls the
  // whole batch back — including the opening movements.
  return withAudit(db, userId, (ctx) => {
    const nextTag = tagAllocator(db);
    const insert = db.prepare(
      `INSERT INTO items
        (tracking_mode, tag_number, name, product_type_id, metal_id, purity_id, stone_type_id,
         making_type_id, occasion_id, origin_kind, source_party_id, gross_mg, less_mg, net_mg,
         touch_bp, wastage_bp, making_mode, making_rate_paisa, hallmark_number,
         hallmark_charge_paisa, status, location_id, notes, created_by)
       VALUES
        (@tracking_mode, @tag_number, @name, @product_type_id, @metal_id, @purity_id, @stone_type_id,
         @making_type_id, @occasion_id, 'IN_HOUSE', NULL, @gross_mg, @less_mg, @net_mg,
         @touch_bp, @wastage_bp, @making_mode, @making_rate_paisa, @hallmark_number,
         @hallmark_charge_paisa, 'IN_STOCK', @location_id, @notes, @created_by)`,
    );

    const insertCost = db.prepare(
      `INSERT INTO item_costs (item_id, intake_rate_paisa_per_gram, labour_paid_paisa, updated_by)
       VALUES (@item_id, @intake, @labour, @user)`,
    );

    let imported = 0;
    let openingMovements = 0;

    for (const row of chosen) {
      const p = row.prepared;
      if (!p) continue; // unreachable: broken rows already threw above
      const tag = p.tagNumber ?? nextTag();

      const info = insert.run({
        tracking_mode: p.trackingMode,
        tag_number: tag,
        name: p.name,
        product_type_id: p.productTypeId,
        metal_id: p.metalId,
        purity_id: p.purityId,
        stone_type_id: p.stoneTypeId,
        making_type_id: p.makingTypeId,
        occasion_id: p.occasionId,
        gross_mg: p.grossMg,
        less_mg: p.lessMg,
        net_mg: p.netMg,
        touch_bp: p.touchBp,
        wastage_bp: p.wastageBp,
        making_mode: p.makingMode,
        making_rate_paisa: p.makingRatePaisa,
        hallmark_number: p.hallmarkNumber,
        hallmark_charge_paisa: p.hallmarkChargePaisa,
        location_id: p.locationId,
        notes: p.notes,
        created_by: userId,
      });
      const id = Number(info.lastInsertRowid);
      imported++;

      /* Only write a cost row when the sheet actually carried one. An empty
         item_costs row is worse than none: the profit report reads a zero
         intake rate as "bought free" and reports the whole sale as margin. */
      if (p.intakeRatePaisaPerGram != null || p.labourPaidPaisa > 0) {
        insertCost.run({
          item_id: id,
          intake: p.intakeRatePaisaPerGram,
          labour: p.labourPaidPaisa,
          user: userId,
        });
      }

      if (opts.postOpeningStock && p.openingPieces > 0) {
        // ITEM mode moves exactly one piece (the schema trigger enforces it);
        // a LOT opens with its full count.
        const pieces = p.trackingMode === 'ITEM' ? 1 : p.openingPieces;
        insertMovement(
          db,
          userId,
          {
            movementType: 'OPENING',
            itemId: id,
            locationId: p.locationId,
            piecesDelta: pieces,
            grossMgDelta: p.grossMg * pieces,
            netMgDelta: p.netMg * pieces,
          },
          ctx,
        );
        openingMovements++;
      }
    }

    // One audit entry for the batch, not one per row: the audit log is
    // hash-chained and a 500-row import would otherwise bury every other event
    // that day. The individual rows are recoverable from the items themselves.
    ctx.record({
      table: 'items',
      rowPk: 0,
      action: 'INSERT',
      changes: { importedItems: imported, openingMovements, source: 'spreadsheet import' },
    });

    return { imported, openingMovements };
  });
}
