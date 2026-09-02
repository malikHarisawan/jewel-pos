/** Parties (customers / suppliers / karigars). Minimal CRUD for now — enough to
 * pick a karigar when issuing a job and a customer at the counter later. */
import type { DB } from '../db/connection.js';
import { withAudit } from '../db/audit.js';
import type { z } from 'zod';
import type { CreatePartyInput, ListPartiesInput } from '../../shared/contracts/index.js';
import type { PartyKind } from '../../shared/domain/enums.js';

type CreateInput = z.input<typeof CreatePartyInput>;
type ListInput = z.input<typeof ListPartiesInput>;

interface PartyRow {
  id: number;
  kind: PartyKind;
  name: string;
  phone: string | null;
  cnic: string | null;
  address: string | null;
  notes: string | null;
}

function mapParty(r: PartyRow) {
  return {
    id: r.id,
    kind: r.kind,
    name: r.name,
    phone: r.phone,
    cnic: r.cnic,
    address: r.address,
    notes: r.notes,
  };
}

export function createParty(db: DB, userId: number, input: CreateInput) {
  return withAudit(db, userId, (ctx) => {
    const info = db
      .prepare(
        `INSERT INTO parties (kind, name, phone, cnic, address, notes, created_by)
         VALUES (@kind, @name, @phone, @cnic, @address, @notes, @user)`,
      )
      .run({
        kind: input.kind,
        name: input.name,
        phone: input.phone ?? null,
        cnic: input.cnic ?? null,
        address: input.address ?? null,
        notes: input.notes ?? null,
        user: userId,
      });
    const id = Number(info.lastInsertRowid);
    ctx.record({ table: 'parties', rowPk: id, action: 'INSERT', changes: { name: input.name, kind: input.kind } });
    const row = db.prepare('SELECT id, kind, name, phone, cnic, address, notes FROM parties WHERE id=?').get(id) as PartyRow;
    return mapParty(row);
  });
}

export function listParties(db: DB, input: ListInput) {
  const clauses: string[] = ['is_active=1'];
  const params: unknown[] = [];
  if (input.kind) {
    clauses.push('kind = ?');
    params.push(input.kind);
  }
  if (input.search) {
    clauses.push('(name LIKE ? OR phone LIKE ?)');
    params.push(`%${input.search}%`, `%${input.search}%`);
  }
  const rows = db
    .prepare(
      `SELECT id, kind, name, phone, cnic, address, notes FROM parties
       WHERE ${clauses.join(' AND ')} ORDER BY name LIMIT ?`,
    )
    .all(...params, input.limit ?? 200) as PartyRow[];
  return rows.map(mapParty);
}
