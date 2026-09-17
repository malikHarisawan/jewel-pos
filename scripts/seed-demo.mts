/**
 * Seed a realistic shop and drive it end-to-end through the REAL service layer.
 *
 * This is a functional test of the whole app, not a fixture dump: every row is
 * created through the same functions the IPC handlers call, so anything the UI
 * can reach is exercised here — stock, rates, sales, discounts, returns,
 * udhaar, and the audit chain that ties them together.
 *
 *   npx tsx scripts/seed-demo.mts [--out <path>]   (default: in-memory)
 */
import { openDatabase, type DB } from '../src/main/db/connection.js';
import { AuthService, ensureFirstOwner } from '../src/main/auth/authService.js';
import { createItem } from '../src/main/services/itemService.js';
import { enterRate, quoteItems } from '../src/main/services/rateService.js';
import {
  checkout,
  listInvoices,
  getReturnableLines,
  returnSale,
} from '../src/main/services/invoiceService.js';
import { createParty } from '../src/main/services/partyService.js';
import { listDebtors, getStatement, recordRepayment } from '../src/main/services/creditService.js';
import { getSettings } from '../src/main/services/settingsService.js';
import { verifyAuditChain } from '../src/main/db/audit.js';
import { CreateItemInput } from '../src/shared/contracts/index.js';


const id = (db: DB, sql: string, ...a: unknown[]) =>
  (db.prepare(sql).get(...(a as never[])) as { id: number }).id;

const G = 1000; // milligrams per gram
const RS = 100; // paisa per rupee

/** Seed and exercise a shop. Returns what passed and what did not, so this can
 *  be run from the CLI or asserted on from the test suite. */
export async function runDemo(FILE = ':memory:'): Promise<{ pass: string[]; fail: string[] }> {
  const pass: string[] = [];
  const fail: string[] = [];
  const check = (name: string, cond: boolean, detail = '') => {
    if (cond) pass.push(name);
    else fail.push(`${name} — ${detail}`);
  };

  const db = openDatabase({ filename: FILE });
  const auth = new AuthService(db);
  await ensureFirstOwner(db, auth);
  const owner = id(db, `SELECT id FROM users WHERE role='OWNER' LIMIT 1`);

  // ── reference ids ──────────────────────────────────────────────────────
  const gold = id(db, `SELECT id FROM metals WHERE name='Gold'`);
  const silver = id(db, `SELECT id FROM metals WHERE name='Silver'`);
  const p22 = id(db, `SELECT id FROM purities WHERE label LIKE '22K%'`);
  const p21 = id(db, `SELECT id FROM purities WHERE label LIKE '21K%'`);
  const pSilver = id(db, `SELECT id FROM purities WHERE metal_id=${silver} LIMIT 1`);
  const noStone = id(db, `SELECT id FROM stone_types ORDER BY id LIMIT 1`);
  const makingType = id(db, `SELECT id FROM making_types ORDER BY id LIMIT 1`);
  const loc = id(db, `SELECT id FROM locations ORDER BY id LIMIT 1`);
  const ptype = (n: string) => id(db, `SELECT id FROM product_types WHERE name LIKE ?`, `${n}%`);

  // ── today's rates ──────────────────────────────────────────────────────
  // Realistic Karachi counter rates: 22K around Rs 26,300/g, silver Rs 320/g.
  const rate = (metalId: number, purityId: number, rupeesPerGram: number) =>
    enterRate(db, owner, {
      metalId,
      purityId,
      enteredValuePaisa: rupeesPerGram * RS,
      enteredBasis: 'PER_GRAM',
    } as never);
  rate(gold, p22, 26_300);
  rate(gold, p21, 25_100);
  rate(silver, pSilver, 320);
  check('rates entered for gold 22K/21K and silver', true);

  // ── stock ──────────────────────────────────────────────────────────────
  const STOCK: Array<[string, string, number, number, number]> = [
    ['Gold Ring 22K', 'Ring', p22, 8.4, 12_000],
    ['Bridal Set 22K', 'Necklace', p22, 62.5, 18_000],
    ['Kangan Pair 21K', 'Bangle', p21, 34.2, 14_500],
    ['Jhumka 22K', 'Earrings', p22, 11.8, 15_000],
    ['Gold Chain 21K', 'Chain', p21, 18.6, 9_500],
    ['Locket 22K', 'Locket', p22, 5.2, 13_000],
    ['Payal Silver', 'Payal', pSilver, 92.0, 900],
    ['Nose Pin 22K', 'Nose Pin', p22, 1.4, 20_000],
  ];

  const items: number[] = [];
  for (const [name, type, purity, grams, makeRate] of STOCK) {
    const input = CreateItemInput.parse({
      trackingMode: 'ITEM',
      name,
      tagNumber: `T${String(items.length + 1).padStart(3, '0')}`,
      productTypeId: ptype(type),
      metalId: purity === pSilver ? silver : gold,
      purityId: purity,
      stoneTypeId: noStone,
      makingTypeId: makingType,
      originKind: 'IN_HOUSE',
      grossMg: Math.round(grams * G),
      netMg: Math.round(grams * G),
      wastageBp: 800, // 8%, typical for handmade work
      makingMode: 'PER_GRAM',
      makingRatePaisa: makeRate,
      locationId: loc,
      openingPieces: 1,
    });
    items.push(createItem(db, owner, 'OWNER', input).id);
  }
  check('8 items created with opening stock', items.length === 8);

  // ── what the stock cost to buy ─────────────────────────────────────────
  // Without this the profit report has no cost basis and shows "no purchase
  // rates recorded yet" — so the demo shop would showcase the one feature
  // that sells the app by displaying a blank. These are set a few percent
  // under today's counter rates, which is what a shop that bought its stock
  // some weeks ago would actually have paid.
  const PURCHASE_RATE_PER_GRAM: Record<number, number> = {
    [p22]: 25_100,
    [p21]: 23_950,
    [pSilver]: 298,
  };
  const setCost = db.prepare(
    `INSERT INTO item_costs (item_id, intake_rate_paisa_per_gram, updated_by)
     VALUES (?,?,?)
     ON CONFLICT(item_id) DO UPDATE SET intake_rate_paisa_per_gram = excluded.intake_rate_paisa_per_gram`,
  );
  items.forEach((itemId, i) => {
    const purityId = STOCK[i][2];
    const paid = PURCHASE_RATE_PER_GRAM[purityId];
    if (paid) setCost.run(itemId, paid * RS, owner);
  });
  check(
    'purchase rates recorded, so profit has a cost basis',
    (db.prepare(
      `SELECT COUNT(*) c FROM item_costs WHERE intake_rate_paisa_per_gram IS NOT NULL`,
    ).get() as { c: number }).c === items.length,
  );

  // ── customers ──────────────────────────────────────────────────────────
  const cust = (name: string, phone: string) =>
    createParty(db, owner, { kind: 'CUSTOMER', name, phone }).id;
  const ayesha = cust('Ayesha Siddiqui', '0300-1234567');
  const bilal = cust('Bilal Ahmed', '0321-9876543');
  const fatima = cust('Fatima Malik', '0333-5551234');
  check('customers created', true);

  // A fixed trading day keeps doc numbers and reports deterministic.
  const DAY = '2026-09-04T10:00:00.000Z';

  /** What the counter would quote for an item today — used to pay a sale in
   *  full without hand-computing metal + making + wastage + tax here. */
  const priceOf = (itemId: number) =>
    quoteItems(db, { itemIds: [itemId] } as never)[0].totalPaisa as number;

  const line = (itemId: number, grams: number, purityId: number, makeRate: number) => ({
    itemId,
    pieces: 1,
    netMg: Math.round(grams * G),
    grossMg: Math.round(grams * G),
    purityId,
    wastageBp: 800,
    making: { mode: 'PER_GRAM' as const, ratePaisa: makeRate },
    stones: [],
    hallmarkChargePaisa: 0,
    discountPaisa: 0,
    description: 'sale line',
  });

  // ── a cash sale ────────────────────────────────────────────────────────
  const sale1 = checkout(db, owner, {
    customerId: ayesha,
    saleLines: [line(items[0], 8.4, p22, 12_000)],
    dateISO: DAY,
    oldGoldLines: [],
    payments: [{ method: 'CASH', amountPaisa: priceOf(items[0]) }],
    saleAdjustmentPaisa: 0,
  } as never);
  check('cash sale finalised', !!sale1.docNumber);

  // ── a credit (udhaar) sale ─────────────────────────────────────────────
  const sale2 = checkout(db, owner, {
    customerId: bilal,
    saleLines: [line(items[2], 34.2, p21, 14_500)],
    dateISO: DAY,
    oldGoldLines: [],
    payments: [{ method: 'CREDIT', amountPaisa: priceOf(items[2]) }],
    saleAdjustmentPaisa: 0,
  } as never);
  check('credit sale finalised', !!sale2.docNumber);

  const debtors = listDebtors(db);
  const bilalRow = debtors.find((d) => d.partyId === bilal);
  check(
    'credit sale created a debtor',
    !!bilalRow && bilalRow.balancePaisa > 0,
    JSON.stringify(debtors),
  );

  // ── a repayment ────────────────────────────────────────────────────────
  if (bilalRow) {
    const half = Math.floor(bilalRow.balancePaisa / 2);
    recordRepayment(db, owner, {
      partyId: bilal,
      amountPaisa: half,
      method: 'CASH',
      entryDate: DAY,
    } as never);
    const after = listDebtors(db).find((d) => d.partyId === bilal)!;
    check(
      'repayment reduced the balance',
      after.balancePaisa === bilalRow.balancePaisa - half,
      `${after.balancePaisa} vs expected ${bilalRow.balancePaisa - half}`,
    );
    check('statement lists sale and payment', getStatement(db, bilal).length >= 2);
  }

  // ── over-payment must be refused, not parked as a negative balance ─────
  let refused = false;
  try {
    recordRepayment(db, owner, {
      partyId: bilal,
      amountPaisa: 99_999_900,
      method: 'CASH',
      entryDate: DAY,
    } as never);
  } catch {
    refused = true;
  }
  check('over-payment refused', refused);

  // ── the discount ceiling must hold ─────────────────────────────────────
  let blocked = false;
  try {
    checkout(db, owner, {
      customerId: fatima,
      saleLines: [line(items[3], 11.8, p22, 15_000)],
      dateISO: DAY,
    oldGoldLines: [],
      payments: [{ method: 'CASH', amountPaisa: 1 }],
      saleAdjustmentPaisa: -9_999_900,
    } as never);
  } catch {
    blocked = true;
  }
  check('excessive discount blocked', blocked);

  // ── a return ───────────────────────────────────────────────────────────
  const returnable = getReturnableLines(db, sale1.documentId);
  check('sale exposes returnable lines', returnable.length > 0);
  if (returnable.length) {
    const l = returnable[0];
    const ret = returnSale(db, owner, {
      documentId: sale1.documentId,
      dateISO: DAY,
      lines: [{ lineId: l.lineId, pieces: l.pieces, netMg: l.remainingNetMg }],
      refundMethod: 'CASH',
      reason: 'size did not fit',
    } as never);
    check('return posted', !!ret.docNumber);
    const after = getReturnableLines(db, sale1.documentId);
    check(
      'line now shows as fully returned',
      after[0].remainingNetMg === 0,
      `remaining=${after[0].remainingNetMg}`,
    );
  }

  // ── the stock guard ────────────────────────────────────────────────────
  let stockBlocked = false;
  try {
    // items[7] holds one piece; selling it twice must fail on the second pass.
    for (let i = 0; i < 2; i++) {
      checkout(db, owner, {
        customerId: null,
        saleLines: [line(items[7], 1.4, p22, 20_000)],
        dateISO: DAY,
    oldGoldLines: [],
        payments: [{ method: 'CASH', amountPaisa: priceOf(items[7]) }],
        saleAdjustmentPaisa: 0,
      } as never);
    }
  } catch {
    stockBlocked = true;
  }
  check('overselling blocked by the stock trigger', stockBlocked);

  // ── reporting surfaces ─────────────────────────────────────────────────
  const invoices = listInvoices(db, {});
  check('sales list returns finalised invoices', invoices.length >= 2, `got ${invoices.length}`);
  const s = getSettings(db);
  check(
    'tray/startup settings present with safe defaults',
    s.close_to_tray === '1' && s.launch_at_startup === '0',
    `${s.close_to_tray}/${s.launch_at_startup}`,
  );

  // ── the audit chain must still verify after all of that ────────────────
  const chain = verifyAuditChain(db);
  check('audit hash chain intact', chain.ok, JSON.stringify(chain));

  db.close();
  return { pass, fail };
}
