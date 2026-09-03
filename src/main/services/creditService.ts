/**
 * Customer credit — udhaar.
 *
 * CREDIT was a selectable payment method that recorded no debt: the sale
 * completed, the money never arrived, and nothing anywhere said who owed it.
 * This module is the missing half.
 *
 * The balance is a fold over an append-only ledger, never a stored number, so
 * it can always be explained by the rows behind it — the same discipline the
 * stock ledger uses.
 *
 * Sign convention, from the SHOP's side: positive = they owe more, negative =
 * they owe less. The running balance is therefore what they currently owe.
 */
import type { DB } from '../db/connection.js';
import { withAudit, type AuditContext } from '../db/audit.js';

export type LedgerEntryType =
  | 'CREDIT_SALE'
  | 'REPAYMENT'
  | 'RETURN_CREDIT'
  | 'OPENING'
  | 'ADJUSTMENT';

export type RepaymentMethod = 'CASH' | 'BANK' | 'CARD';

export interface PostEntryInput {
  partyId: number;
  entryType: LedgerEntryType;
  /** Signed paisa: positive increases the debt, negative reduces it. */
  amountPaisa: number;
  documentId?: number | null;
  method?: RepaymentMethod | null;
  notes?: string | null;
  entryDate: string;
}

/**
 * The only way a row enters party_ledger. Callers inside a bigger transaction
 * (checkout, returns) pass their own audit context so the whole thing commits
 * or rolls back together.
 */
export function postEntry(
  db: DB,
  userId: number,
  input: PostEntryInput,
  ctx?: AuditContext,
): number {
  if (input.amountPaisa === 0) {
    throw new Error('a ledger entry cannot be zero');
  }

  const doInsert = (audit: AuditContext): number => {
    const info = db
      .prepare(
        `INSERT INTO party_ledger
           (party_id, entry_type, amount_paisa, document_id, method, notes, entry_date, created_by)
         VALUES (@party_id, @entry_type, @amount_paisa, @document_id, @method, @notes,
                 @entry_date, @created_by)`,
      )
      .run({
        party_id: input.partyId,
        entry_type: input.entryType,
        amount_paisa: input.amountPaisa,
        document_id: input.documentId ?? null,
        method: input.method ?? null,
        notes: input.notes ?? null,
        entry_date: input.entryDate,
        created_by: userId,
      });
    const id = Number(info.lastInsertRowid);
    audit.record({ table: 'party_ledger', rowPk: id, action: 'INSERT', changes: input });
    return id;
  };

  if (ctx) return doInsert(ctx);
  return withAudit(db, userId, doInsert);
}

/** What this party owes right now, in paisa. Negative means the shop owes them
 * (an over-payment, or a refund credited against nothing). */
export function getBalance(db: DB, partyId: number): number {
  const row = db
    .prepare('SELECT COALESCE(SUM(amount_paisa), 0) AS bal FROM party_ledger WHERE party_id=?')
    .get(partyId) as { bal: number };
  return row.bal;
}

export interface LedgerRow {
  id: number;
  entryType: LedgerEntryType;
  amountPaisa: number;
  documentId: number | null;
  docNumber: string | null;
  method: string | null;
  notes: string | null;
  entryDate: string;
  /** Balance after this entry, oldest-first — the "running total" column. */
  balanceAfterPaisa: number;
}

/** One party's statement, oldest first, with a running balance. */
export function getStatement(db: DB, partyId: number): LedgerRow[] {
  const rows = db
    .prepare(
      `SELECT l.id, l.entry_type, l.amount_paisa, l.document_id, l.method, l.notes, l.entry_date,
              d.doc_number
       FROM party_ledger l
       LEFT JOIN documents d ON d.id = l.document_id
       WHERE l.party_id=?
       ORDER BY l.entry_date, l.id`,
    )
    .all(partyId) as Array<{
    id: number;
    entry_type: LedgerEntryType;
    amount_paisa: number;
    document_id: number | null;
    method: string | null;
    notes: string | null;
    entry_date: string;
    doc_number: string | null;
  }>;

  let running = 0;
  return rows.map((r) => {
    running += r.amount_paisa;
    return {
      id: r.id,
      entryType: r.entry_type,
      amountPaisa: r.amount_paisa,
      documentId: r.document_id,
      docNumber: r.doc_number,
      method: r.method,
      notes: r.notes,
      entryDate: r.entry_date,
      balanceAfterPaisa: running,
    };
  });
}

export interface DebtorRow {
  partyId: number;
  name: string;
  phone: string | null;
  balancePaisa: number;
  lastEntryDate: string | null;
}

/**
 * Everyone with an outstanding balance, biggest debt first — the list the owner
 * actually wants ("who owes me money?").
 *
 * Parties with a settled account are omitted: a zero balance is not news. Pass
 * includeSettled to see everyone who ever had an entry.
 */
export function listDebtors(db: DB, includeSettled = false): DebtorRow[] {
  const having = includeSettled ? '' : 'HAVING SUM(l.amount_paisa) != 0';
  const rows = db
    .prepare(
      `SELECT p.id, p.name, p.phone,
              SUM(l.amount_paisa) AS bal,
              MAX(l.entry_date) AS last_date
       FROM party_ledger l
       JOIN parties p ON p.id = l.party_id
       GROUP BY p.id, p.name, p.phone
       ${having}
       ORDER BY bal DESC, p.name`,
    )
    .all() as Array<{
    id: number;
    name: string;
    phone: string | null;
    bal: number;
    last_date: string | null;
  }>;

  return rows.map((r) => ({
    partyId: r.id,
    name: r.name,
    phone: r.phone,
    balancePaisa: r.bal,
    lastEntryDate: r.last_date,
  }));
}

export interface RecordRepaymentInput {
  partyId: number;
  amountPaisa: number;
  method: RepaymentMethod;
  entryDate: string;
  notes?: string | null;
}

/**
 * A customer pays down what they owe.
 *
 * Over-payment is refused rather than silently parked as a negative balance:
 * at the counter that is nearly always a typo, and quietly turning it into shop
 * credit hides the mistake until it is much harder to unpick.
 */
export function recordRepayment(
  db: DB,
  userId: number,
  input: RecordRepaymentInput,
): { entryId: number; balancePaisa: number } {
  return withAudit(db, userId, (audit) => {
    if (input.amountPaisa <= 0) {
      throw new Error('a repayment must be a positive amount');
    }
    const owed = getBalance(db, input.partyId);
    if (owed <= 0) {
      throw new Error('this account has nothing outstanding');
    }
    if (input.amountPaisa > owed) {
      throw new Error(
        `payment is more than the ${(owed / 100).toFixed(2)} outstanding; ` +
          `take the balance or correct the amount`,
      );
    }

    const entryId = postEntry(
      db,
      userId,
      {
        partyId: input.partyId,
        entryType: 'REPAYMENT',
        amountPaisa: -input.amountPaisa, // reduces what they owe
        method: input.method,
        notes: input.notes ?? null,
        entryDate: input.entryDate,
      },
      audit,
    );

    return { entryId, balancePaisa: getBalance(db, input.partyId) };
  });
}
