import { describe, it, expect, beforeEach } from 'vitest';
import { openDatabase, type DB } from '../src/main/db/connection.js';
import { createParty } from '../src/main/services/partyService.js';
import { purchaseIn } from '../src/main/services/stockService.js';
import {
  issueJob,
  receiveJob,
  listJobs,
  karigarAccounts,
  rawMetalBalance,
} from '../src/main/services/karigarService.js';
import { getBalance } from '../src/main/services/ledgerService.js';

let db: DB;

function purity(d: DB, label: string) {
  return (d.prepare('SELECT id FROM purities WHERE label=?').get(label) as { id: number }).id;
}

/** Ensure the RAW-<purity> lot exists and top it up so we can issue from it. */
function stockRawMetal(d: DB, purityId: number, netMg: number) {
  // issue once with 0? No — create the lot by issuing a tiny job then top up.
  // Simpler: the lot is created lazily on first issue; instead pre-create via a
  // throwaway issue is messy. Use purchaseIn against the lot after it exists.
  // We trigger lot creation by calling rawMetalBalance (returns 0, no lot) then
  // issue creates it — but issue needs stock. So: create lot by issuing then
  // reversing is overkill. Instead, directly create the RAW lot via an initial
  // purchase into a freshly-made lot id. Easiest: run a 0-net issue is invalid.
  // We'll just purchaseIn after ensuring the lot via a helper below.
  const tag = `RAW-${purityId}`;
  let item = d.prepare('SELECT id FROM items WHERE tag_number=?').get(tag) as
    | { id: number }
    | undefined;
  if (!item) {
    const meta = d
      .prepare(
        `SELECT metal_id,
                (SELECT id FROM stone_types WHERE name='Plain') st,
                (SELECT id FROM making_types ORDER BY sort_order LIMIT 1) mt,
                (SELECT id FROM product_types ORDER BY sort_order LIMIT 1) pt
         FROM purities WHERE id=?`,
      )
      .get(purityId) as { metal_id: number; st: number; mt: number; pt: number };
    const info = d
      .prepare(
        `INSERT INTO items (tracking_mode, tag_number, name, product_type_id, metal_id, purity_id,
           stone_type_id, making_type_id, origin_kind, gross_mg, less_mg, net_mg, status, location_id, created_by)
         VALUES ('LOT', @tag, 'Raw', @pt, @metal, @purity, @st, @mt, 'IN_HOUSE', 0,0,0,'IN_STOCK',1,1)`,
      )
      .run({ tag, pt: meta.pt, metal: meta.metal_id, purity: purityId, st: meta.st, mt: meta.mt });
    item = { id: Number(info.lastInsertRowid) };
  }
  purchaseIn(d, 1, { itemId: item.id, pieces: 0, grossMg: netMg, netMg });
}

beforeEach(() => {
  db = openDatabase({ filename: ':memory:' });
  db.prepare(
    `INSERT INTO users (id, username, display_name, pin_hash, role) VALUES (1,'owner','Owner','x','OWNER')`,
  ).run();
});

function makeKarigar(d: DB, name = 'Aslam') {
  return createParty(d, 1, { kind: 'KARIGAR', name }).id;
}

describe('karigar issue', () => {
  it('issues metal out of the raw lot and opens a job', () => {
    const p22 = purity(db, '22K / 916');
    stockRawMetal(db, p22, 100_000); // 100g on hand
    const k = makeKarigar(db);

    const job = issueJob(db, 1, '2026-07-29T10:00:00.000Z', {
      karigarPartyId: k,
      purityId: p22,
      issuedGrossMg: 50_000,
      issuedNetMg: 50_000,
      allowedWastageBp: 200, // 2%
      labourRatePaisa: 30_000,
    });
    expect(job.status).toBe('OPEN');
    expect(job.jobNumber).toBe('JOB-2026-0001');
    expect(job.issuedNetMg).toBe(50_000);
    // raw lot drawn down 100g -> 50g
    expect(rawMetalBalance(db, p22)).toBe(50_000);
  });

  it('cannot issue more than the raw metal on hand', () => {
    const p22 = purity(db, '22K / 916');
    stockRawMetal(db, p22, 10_000);
    const k = makeKarigar(db);
    expect(() =>
      issueJob(db, 1, '2026-07-29T10:00:00.000Z', {
        karigarPartyId: k,
        purityId: p22,
        issuedGrossMg: 50_000,
        issuedNetMg: 50_000,
        allowedWastageBp: 200,
        labourRatePaisa: 0,
      }),
    ).toThrow(/insufficient stock/);
  });
});

describe('karigar receive + wastage flag', () => {
  function issue(d: DB, k: number, p22: number, wastageBp: number) {
    stockRawMetal(d, p22, 100_000);
    return issueJob(d, 1, '2026-07-29T10:00:00.000Z', {
      karigarPartyId: k,
      purityId: p22,
      issuedGrossMg: 50_000,
      issuedNetMg: 50_000,
      allowedWastageBp: wastageBp,
      labourRatePaisa: 0,
    });
  }

  it('within tolerance: not flagged, items created and in stock', () => {
    const p22 = purity(db, '22K / 916');
    const k = makeKarigar(db);
    const job = issue(db, k, p22, 200); // allow 2% = 1000mg
    // received 49.2g -> wastage 0.8g (< 1g allowed)
    const done = receiveJob(db, 1, {
      jobId: job.id,
      pieces: [{ name: 'Bangle', grossMg: 49_200, netMg: 49_200 }],
    });
    expect(done.status).toBe('RECEIVED');
    expect(done.actualWastageMg).toBe(800);
    expect(done.overTolerance).toBe(false);
    // finished item entered stock
    const item = db.prepare(`SELECT id FROM items WHERE name='Bangle'`).get() as { id: number };
    expect(getBalance(db, item.id).netMg).toBe(49_200);
  });

  it('over tolerance: flagged', () => {
    const p22 = purity(db, '22K / 916');
    const k = makeKarigar(db);
    const job = issue(db, k, p22, 200); // allow 2% = 1000mg
    // received 48.5g -> wastage 1.5g (> 1g allowed) => FLAG
    const done = receiveJob(db, 1, {
      jobId: job.id,
      pieces: [{ name: 'Chain', grossMg: 48_500, netMg: 48_500 }],
    });
    expect(done.actualWastageMg).toBe(1_500);
    expect(done.overTolerance).toBe(true);
  });

  it('splits into multiple finished pieces and sums received weight', () => {
    const p22 = purity(db, '22K / 916');
    const k = makeKarigar(db);
    const job = issue(db, k, p22, 300);
    const done = receiveJob(db, 1, {
      jobId: job.id,
      pieces: [
        { name: 'Ring A', grossMg: 24_000, netMg: 24_000 },
        { name: 'Ring B', grossMg: 25_000, netMg: 25_000 },
      ],
    });
    expect(done.receivedNetMg).toBe(49_000);
    expect(done.actualWastageMg).toBe(1_000);
  });

  it('cannot receive a job twice', () => {
    const p22 = purity(db, '22K / 916');
    const k = makeKarigar(db);
    const job = issue(db, k, p22, 200);
    receiveJob(db, 1, { jobId: job.id, pieces: [{ name: 'X', grossMg: 49_000, netMg: 49_000 }] });
    expect(() =>
      receiveJob(db, 1, { jobId: job.id, pieces: [{ name: 'Y', grossMg: 100, netMg: 100 }] }),
    ).toThrow(/not open/);
  });
});

describe('karigar metal account', () => {
  it('tracks gold currently held (open jobs) and flags count', () => {
    const p22 = purity(db, '22K / 916');
    const k = makeKarigar(db, 'Bilal');
    stockRawMetal(db, p22, 200_000);
    // one open job (held), one received over-tolerance
    issueJob(db, 1, '2026-07-29T10:00:00.000Z', {
      karigarPartyId: k, purityId: p22, issuedGrossMg: 30_000, issuedNetMg: 30_000,
      allowedWastageBp: 100, labourRatePaisa: 0,
    });
    const j2 = issueJob(db, 1, '2026-07-29T10:00:00.000Z', {
      karigarPartyId: k, purityId: p22, issuedGrossMg: 40_000, issuedNetMg: 40_000,
      allowedWastageBp: 100, labourRatePaisa: 0,
    });
    receiveJob(db, 1, { jobId: j2.id, pieces: [{ name: 'Set', grossMg: 38_000, netMg: 38_000 }] });

    const acct = karigarAccounts(db).find((a) => a.karigarPartyId === k)!;
    expect(acct.holdingMg).toBe(30_000); // only the open job
    expect(acct.totalIssuedMg).toBe(70_000);
    expect(acct.totalReceivedMg).toBe(38_000);
    expect(acct.overToleranceJobs).toBe(1); // the 40g->38g job (2g > 400mg allowed)
    expect(acct.jobCount).toBe(2);
  });
});

describe('listJobs', () => {
  it('filters by status', () => {
    const p22 = purity(db, '22K / 916');
    const k = makeKarigar(db);
    stockRawMetal(db, p22, 100_000);
    const j = issueJob(db, 1, '2026-07-29T10:00:00.000Z', {
      karigarPartyId: k, purityId: p22, issuedGrossMg: 20_000, issuedNetMg: 20_000,
      allowedWastageBp: 200, labourRatePaisa: 0,
    });
    expect(listJobs(db, { status: 'OPEN', limit: 100 })).toHaveLength(1);
    receiveJob(db, 1, { jobId: j.id, pieces: [{ name: 'P', grossMg: 19_800, netMg: 19_800 }] });
    expect(listJobs(db, { status: 'OPEN', limit: 100 })).toHaveLength(0);
    expect(listJobs(db, { status: 'RECEIVED', limit: 100 })).toHaveLength(1);
  });
});
