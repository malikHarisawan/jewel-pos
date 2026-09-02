/**
 * Karigar (goldsmith) job cards & wastage reconciliation.
 *
 * A job is one issue→receive cycle. Issuing hands the karigar metal (weight OUT
 * of a per-purity "Karigar Raw Metal" lot); receiving brings finished pieces
 * back as new items (weight IN). The difference is wastage; if it exceeds the
 * agreed % the job is flagged. A karigar's metal account = Σ(issued − received)
 * across their jobs — how much of your gold they're still holding.
 *
 * All metal moves through the append-only ledger via the ledger service.
 */
import type { DB } from '../db/connection.js';
import { withAudit } from '../db/audit.js';
import { insertMovement, getBalance } from './ledgerService.js';
import type { z } from 'zod';
import type {
  IssueJobInput,
  ReceiveJobInput,
  ListJobsInput,
} from '../../shared/contracts/index.js';

// z.input (not z.infer): fields with zod .default() are optional on the way IN,
// which matches how callers/tests supply these objects.
type IssueInput = z.input<typeof IssueJobInput>;
type ReceiveInput = z.input<typeof ReceiveJobInput>;
type ListInput = z.input<typeof ListJobsInput>;

function rootLocation(db: DB): number {
  return (db.prepare(`SELECT id FROM locations ORDER BY id LIMIT 1`).get() as { id: number }).id;
}

/** A per-purity LOT that holds raw metal available to issue to karigars. Topped
 * up via stock.purchaseIn; issuing draws it down (guarded against going negative). */
function ensureRawMetalLot(db: DB, userId: number, purityId: number): number {
  const tag = `RAW-${purityId}`;
  const existing = db.prepare('SELECT id FROM items WHERE tag_number=?').get(tag) as
    | { id: number }
    | undefined;
  if (existing) return existing.id;
  const meta = db
    .prepare(
      `SELECT p.metal_id,
              (SELECT id FROM product_types ORDER BY sort_order LIMIT 1) pt,
              (SELECT id FROM stone_types WHERE name='Plain') st,
              (SELECT id FROM making_types ORDER BY sort_order LIMIT 1) mt
       FROM purities p WHERE p.id=?`,
    )
    .get(purityId) as { metal_id: number; pt: number; st: number; mt: number };
  const info = db
    .prepare(
      `INSERT INTO items
        (tracking_mode, tag_number, name, product_type_id, metal_id, purity_id, stone_type_id,
         making_type_id, origin_kind, gross_mg, less_mg, net_mg, status, location_id, created_by)
       VALUES ('LOT', @tag, @name, @pt, @metal, @purity, @st, @mt, 'IN_HOUSE', 0, 0, 0, 'IN_STOCK', @loc, @user)`,
    )
    .run({
      tag,
      name: `Karigar Raw Metal (purity ${purityId})`,
      pt: meta.pt,
      metal: meta.metal_id,
      purity: purityId,
      st: meta.st,
      mt: meta.mt,
      loc: rootLocation(db),
      user: userId,
    });
  return Number(info.lastInsertRowid);
}

function issueJobNumber(db: DB, fiscalYear: number): string {
  const seq = db
    .prepare(
      `UPDATE doc_sequences SET next_no = next_no + 1
       WHERE doc_type='KARIGAR_JOB' AND fiscal_year=? RETURNING next_no - 1 AS n, prefix`,
    )
    .get(fiscalYear) as { n: number; prefix: string } | undefined;
  if (!seq) throw new Error(`no KARIGAR_JOB sequence for ${fiscalYear}`);
  return `${seq.prefix}-${fiscalYear}-${String(seq.n).padStart(4, '0')}`;
}

/** Hand metal to a karigar. dateISO is supplied by the handler (no clock in services). */
export function issueJob(db: DB, userId: number, dateISO: string, input: IssueInput) {
  return withAudit(db, userId, (ctx) => {
    const rawLot = ensureRawMetalLot(db, userId, input.purityId);
    const loc = rootLocation(db);
    const fiscalYear = Number(dateISO.slice(0, 4));
    const jobNumber = issueJobNumber(db, fiscalYear);

    const info = db
      .prepare(
        `INSERT INTO karigar_jobs
          (job_number, karigar_party_id, purity_id, status, issued_gross_mg, issued_net_mg,
           allowed_wastage_bp, labour_rate_paisa, issued_by)
         VALUES (@job, @karigar, @purity, 'OPEN', @gross, @net, @wastage, @labour, @user)`,
      )
      .run({
        job: jobNumber,
        karigar: input.karigarPartyId,
        purity: input.purityId,
        gross: input.issuedGrossMg,
        net: input.issuedNetMg,
        wastage: input.allowedWastageBp ?? 0,
        labour: input.labourRatePaisa ?? 0,
        user: userId,
      });
    const jobId = Number(info.lastInsertRowid);

    // Post the metal out of the raw lot (guarded: can't issue what you don't have).
    const movementId = insertMovement(
      db,
      userId,
      {
        movementType: 'KARIGAR_ISSUE',
        itemId: rawLot,
        locationId: loc,
        piecesDelta: 0,
        grossMgDelta: -input.issuedGrossMg,
        netMgDelta: -input.issuedNetMg,
        partyId: input.karigarPartyId,
        notes: `Issue for ${jobNumber}`,
      },
      ctx,
    );
    db.prepare('UPDATE karigar_jobs SET issue_movement_id=? WHERE id=?').run(movementId, jobId);
    ctx.record({
      table: 'karigar_jobs',
      rowPk: jobId,
      action: 'INSERT',
      changes: { jobNumber, issuedNetMg: input.issuedNetMg },
    });
    return getJob(db, jobId);
  });
}

/** Receive finished pieces back. Creates the items, posts their intake, computes
 * wastage and flags over-tolerance. */
export function receiveJob(db: DB, userId: number, input: ReceiveInput) {
  return withAudit(db, userId, (ctx) => {
    const job = db.prepare('SELECT * FROM karigar_jobs WHERE id=?').get(input.jobId) as
      | {
          id: number;
          purity_id: number;
          status: string;
          issued_net_mg: number;
          allowed_wastage_bp: number;
          karigar_party_id: number;
        }
      | undefined;
    if (!job) throw new Error(`job ${input.jobId} not found`);
    if (job.status !== 'OPEN') throw new Error('job is not open');

    const loc = rootLocation(db);
    const meta = db
      .prepare(
        `SELECT metal_id,
                (SELECT id FROM stone_types WHERE name='Plain') st,
                (SELECT id FROM making_types WHERE name='Handmade') mt,
                (SELECT id FROM product_types ORDER BY sort_order LIMIT 1) pt
         FROM purities WHERE id=?`,
      )
      .get(job.purity_id) as { metal_id: number; st: number; mt: number; pt: number };

    let receivedNet = 0;
    const insertItem = db.prepare(
      `INSERT INTO items
        (tracking_mode, tag_number, name, product_type_id, metal_id, purity_id, stone_type_id,
         making_type_id, origin_kind, source_party_id, gross_mg, less_mg, net_mg, status,
         location_id, created_by)
       VALUES ('ITEM', @tag, @name, @pt, @metal, @purity, @st, @mt, 'KARIGAR', @karigar,
               @gross, @less, @net, 'IN_STOCK', @loc, @user)`,
    );
    const linkItem = db.prepare(
      `INSERT INTO karigar_job_items (job_id, item_id) VALUES (?,?)`,
    );

    for (const piece of input.pieces) {
      const lessMg = piece.grossMg - piece.netMg;
      const itemInfo = insertItem.run({
        tag: piece.tagNumber ?? null,
        name: piece.name,
        pt: piece.productTypeId ?? meta.pt,
        metal: meta.metal_id,
        purity: job.purity_id,
        st: meta.st,
        mt: meta.mt,
        karigar: job.karigar_party_id,
        gross: piece.grossMg,
        less: lessMg,
        net: piece.netMg,
        loc,
        user: userId,
      });
      const itemId = Number(itemInfo.lastInsertRowid);
      linkItem.run(job.id, itemId);
      insertMovement(
        db,
        userId,
        {
          movementType: 'KARIGAR_RECEIVE',
          itemId,
          locationId: loc,
          piecesDelta: 1,
          grossMgDelta: piece.grossMg,
          netMgDelta: piece.netMg,
          partyId: job.karigar_party_id,
          notes: `Received from job ${job.id}`,
        },
        ctx,
      );
      receivedNet += piece.netMg;
    }

    const actualWastage = job.issued_net_mg - receivedNet;
    const allowedWastageMg = Math.round((job.issued_net_mg * job.allowed_wastage_bp) / 10_000);
    const overTolerance = actualWastage > allowedWastageMg ? 1 : 0;

    db.prepare(
      `UPDATE karigar_jobs SET
         status='RECEIVED', received_net_mg=@received, actual_wastage_mg=@wastage,
         over_tolerance=@over, labour_paid_paisa=@labour,
         received_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'), received_by=@user, notes=@notes
       WHERE id=@id`,
    ).run({
      id: job.id,
      received: receivedNet,
      wastage: actualWastage,
      over: overTolerance,
      labour: input.labourPaidPaisa ?? 0,
      user: userId,
      notes: input.notes ?? null,
    });
    ctx.record({
      table: 'karigar_jobs',
      rowPk: job.id,
      action: 'UPDATE',
      changes: { receivedNetMg: receivedNet, actualWastageMg: actualWastage, overTolerance },
    });
    return getJob(db, job.id);
  });
}

interface JobRow {
  id: number;
  job_number: string | null;
  karigar_party_id: number;
  karigar_name: string;
  purity_id: number;
  purity_label: string;
  status: string;
  issued_gross_mg: number;
  issued_net_mg: number;
  allowed_wastage_bp: number;
  labour_rate_paisa: number;
  received_net_mg: number | null;
  actual_wastage_mg: number | null;
  over_tolerance: number;
  labour_paid_paisa: number;
  issued_at: string;
  received_at: string | null;
  notes: string | null;
}

const SELECT_JOB = `
  SELECT j.*, p.name AS karigar_name, pu.label AS purity_label
  FROM karigar_jobs j
  JOIN parties p ON p.id = j.karigar_party_id
  JOIN purities pu ON pu.id = j.purity_id`;

function mapJob(r: JobRow) {
  return {
    id: r.id,
    jobNumber: r.job_number,
    karigarPartyId: r.karigar_party_id,
    karigarName: r.karigar_name,
    purityId: r.purity_id,
    purityLabel: r.purity_label,
    status: r.status as 'OPEN' | 'RECEIVED' | 'CANCELLED',
    issuedGrossMg: r.issued_gross_mg,
    issuedNetMg: r.issued_net_mg,
    allowedWastageBp: r.allowed_wastage_bp,
    labourRatePaisa: r.labour_rate_paisa,
    receivedNetMg: r.received_net_mg,
    actualWastageMg: r.actual_wastage_mg,
    overTolerance: r.over_tolerance === 1,
    labourPaidPaisa: r.labour_paid_paisa,
    issuedAt: r.issued_at,
    receivedAt: r.received_at,
    notes: r.notes,
  };
}

export function getJob(db: DB, id: number) {
  const r = db.prepare(`${SELECT_JOB} WHERE j.id=?`).get(id) as JobRow | undefined;
  if (!r) throw new Error(`job ${id} not found`);
  return mapJob(r);
}

export function listJobs(db: DB, input: ListInput) {
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (input.status) {
    clauses.push('j.status = ?');
    params.push(input.status);
  }
  if (input.karigarPartyId != null) {
    clauses.push('j.karigar_party_id = ?');
    params.push(input.karigarPartyId);
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const rows = db
    .prepare(`${SELECT_JOB} ${where} ORDER BY j.id DESC LIMIT ?`)
    .all(...params, input.limit ?? 200) as JobRow[];
  return rows.map(mapJob);
}

/** Metal account per karigar: how much net gold each is still holding
 * (issued − received across OPEN jobs), plus over-tolerance job count. */
export function karigarAccounts(db: DB) {
  const rows = db
    .prepare(
      `SELECT p.id AS karigar_party_id, p.name AS karigar_name,
              COALESCE(SUM(CASE WHEN j.status='OPEN' THEN j.issued_net_mg ELSE 0 END),0) AS holding_mg,
              COALESCE(SUM(j.issued_net_mg),0) AS total_issued_mg,
              COALESCE(SUM(j.received_net_mg),0) AS total_received_mg,
              COALESCE(SUM(j.over_tolerance),0) AS over_tolerance_jobs,
              COUNT(j.id) AS job_count
       FROM parties p
       LEFT JOIN karigar_jobs j ON j.karigar_party_id = p.id
       WHERE p.kind='KARIGAR' AND p.is_active=1
       GROUP BY p.id, p.name
       ORDER BY p.name`,
    )
    .all() as Array<{
    karigar_party_id: number;
    karigar_name: string;
    holding_mg: number;
    total_issued_mg: number;
    total_received_mg: number;
    over_tolerance_jobs: number;
    job_count: number;
  }>;
  return rows.map((r) => ({
    karigarPartyId: r.karigar_party_id,
    karigarName: r.karigar_name,
    holdingMg: r.holding_mg,
    totalIssuedMg: r.total_issued_mg,
    totalReceivedMg: r.total_received_mg,
    overToleranceJobs: r.over_tolerance_jobs,
    jobCount: r.job_count,
  }));
}

/** Balance available in the raw-metal lot for a purity (for the issue form). */
export function rawMetalBalance(db: DB, purityId: number): number {
  const tag = `RAW-${purityId}`;
  const item = db.prepare('SELECT id FROM items WHERE tag_number=?').get(tag) as
    | { id: number }
    | undefined;
  if (!item) return 0;
  return getBalance(db, item.id).netMg;
}

/** Buy raw metal into the per-purity raw lot (creating it if needed). This is the
 * intake side that feeds karigar issues — a weight-only PURCHASE_IN. */
export function rawIntake(
  db: DB,
  userId: number,
  input: { purityId: number; netMg: number; partyId?: number | null; notes?: string },
) {
  return withAudit(db, userId, (ctx) => {
    const lot = ensureRawMetalLot(db, userId, input.purityId);
    insertMovement(
      db,
      userId,
      {
        movementType: 'PURCHASE_IN',
        itemId: lot,
        locationId: rootLocation(db),
        piecesDelta: 0,
        grossMgDelta: input.netMg,
        netMgDelta: input.netMg,
        partyId: input.partyId ?? null,
        notes: input.notes ?? 'Raw metal purchase',
      },
      ctx,
    );
    return { netMg: getBalance(db, lot).netMg };
  });
}

/** All per-purity raw-metal lots with their current balance, for the intake UI. */
export function rawBalances(db: DB) {
  const rows = db
    .prepare(
      `SELECT i.purity_id, pu.label AS purity_label, m.name AS metal_name,
              COALESCE(b.net_mg, 0) AS net_mg
       FROM items i
       JOIN purities pu ON pu.id = i.purity_id
       JOIN metals m ON m.id = i.metal_id
       LEFT JOIN item_balances b ON b.item_id = i.id
       WHERE i.tag_number LIKE 'RAW-%'
       ORDER BY m.sort_order, pu.sort_order`,
    )
    .all() as Array<{ purity_id: number; purity_label: string; metal_name: string; net_mg: number }>;
  return rows.map((r) => ({
    purityId: r.purity_id,
    purityLabel: r.purity_label,
    metalName: r.metal_name,
    netMg: r.net_mg,
  }));
}
