/**
 * Local authentication. PINs/passwords are argon2id-hashed. The active session
 * lives ONLY in main-process memory — the renderer never asserts a role; the IPC
 * router injects the session's role into every call. Failed attempts are
 * rate-limited in-process to slow offline PIN guessing.
 */
import { hash, verify } from '@node-rs/argon2';
import type { DB } from '../db/connection.js';
import { withAudit } from '../db/audit.js';
import type { Role } from '../../shared/domain/enums.js';

export interface Session {
  userId: number;
  username: string;
  displayName: string;
  role: Role;
  loginAt: number;
}

export interface UserRow {
  id: number;
  username: string;
  display_name: string;
  pin_hash: string;
  role: Role;
  is_active: number;
}

const MAX_ATTEMPTS = 5;
const LOCKOUT_MS = 30_000;

export class AuthService {
  private session: Session | null = null;
  private attempts = new Map<string, { count: number; until: number }>();

  constructor(
    private db: DB,
    private now: () => number = () => Date.now(),
  ) {}

  async hashSecret(secret: string): Promise<string> {
    return hash(secret, { algorithm: 2 /* argon2id */ });
  }

  /** Create a user (owner-only in practice; enforced at the router). */
  async createUser(
    actingUserId: number,
    input: { username: string; displayName: string; secret: string; role: Role },
  ): Promise<number> {
    const pinHash = await this.hashSecret(input.secret);
    return withAudit(this.db, actingUserId, (ctx) => {
      const info = this.db
        .prepare(
          `INSERT INTO users (username, display_name, pin_hash, role) VALUES (?,?,?,?)`,
        )
        .run(input.username, input.displayName, pinHash, input.role);
      const id = Number(info.lastInsertRowid);
      ctx.record({
        table: 'users',
        rowPk: id,
        action: 'INSERT',
        changes: { username: input.username, role: input.role },
      });
      return id;
    });
  }

  listUsers(): Array<{ id: number; username: string; displayName: string; role: Role; isActive: boolean }> {
    const rows = this.db
      .prepare(`SELECT id, username, display_name, role, is_active FROM users ORDER BY id`)
      .all() as Array<{ id: number; username: string; display_name: string; role: Role; is_active: number }>;
    return rows.map((r) => ({
      id: r.id,
      username: r.username,
      displayName: r.display_name,
      role: r.role,
      isActive: r.is_active === 1,
    }));
  }

  /** Enable/disable a user. The last active OWNER cannot be disabled. */
  setUserActive(actingUserId: number, userId: number, active: boolean): void {
    withAudit(this.db, actingUserId, (ctx) => {
      if (!active) {
        const target = this.db.prepare('SELECT role FROM users WHERE id=?').get(userId) as
          | { role: Role }
          | undefined;
        if (target?.role === 'OWNER') {
          const owners = (
            this.db.prepare(`SELECT count(*) c FROM users WHERE role='OWNER' AND is_active=1`).get() as {
              c: number;
            }
          ).c;
          if (owners <= 1) throw new Error('cannot disable the last active owner');
        }
      }
      this.db.prepare('UPDATE users SET is_active=? WHERE id=?').run(active ? 1 : 0, userId);
      ctx.record({ table: 'users', rowPk: userId, action: 'UPDATE', changes: { isActive: active } });
    });
  }

  /** Owner/manager resets another user's PIN. */
  async resetPin(actingUserId: number, userId: number, newSecret: string): Promise<void> {
    const pinHash = await this.hashSecret(newSecret);
    withAudit(this.db, actingUserId, (ctx) => {
      this.db.prepare('UPDATE users SET pin_hash=? WHERE id=?').run(pinHash, userId);
      ctx.record({ table: 'users', rowPk: userId, action: 'UPDATE', changes: { pinReset: true } });
    });
  }

  /** A user changes their own PIN (must supply the current one). */
  async changeOwnPin(userId: number, currentSecret: string, newSecret: string): Promise<void> {
    const user = this.db.prepare('SELECT pin_hash FROM users WHERE id=?').get(userId) as
      | { pin_hash: string }
      | undefined;
    if (!user || !(await verify(user.pin_hash, currentSecret))) {
      throw new Error('current PIN is incorrect');
    }
    const pinHash = await this.hashSecret(newSecret);
    withAudit(this.db, userId, (ctx) => {
      this.db.prepare('UPDATE users SET pin_hash=? WHERE id=?').run(pinHash, userId);
      ctx.record({ table: 'users', rowPk: userId, action: 'UPDATE', changes: { pinChanged: true } });
    });
  }

  async login(username: string, secret: string): Promise<Session> {
    const gate = this.attempts.get(username);
    if (gate && gate.until > this.now()) {
      throw new Error('too many attempts; try again shortly');
    }

    const user = this.db
      .prepare(
        `SELECT id, username, display_name, pin_hash, role, is_active FROM users WHERE username=?`,
      )
      .get(username) as UserRow | undefined;

    const ok = user && user.is_active === 1 && (await verify(user.pin_hash, secret));
    if (!ok || !user) {
      this.registerFailure(username);
      throw new Error('invalid credentials');
    }

    this.attempts.delete(username);
    this.session = {
      userId: user.id,
      username: user.username,
      displayName: user.display_name,
      role: user.role,
      loginAt: this.now(),
    };
    withAudit(this.db, user.id, (ctx) =>
      ctx.record({ table: 'users', rowPk: user.id, action: 'LOGIN', changes: { username } }),
    );
    return this.session;
  }

  private registerFailure(username: string) {
    const g = this.attempts.get(username) ?? { count: 0, until: 0 };
    g.count += 1;
    if (g.count >= MAX_ATTEMPTS) {
      g.until = this.now() + LOCKOUT_MS;
      g.count = 0;
    }
    this.attempts.set(username, g);
  }

  logout(): void {
    this.session = null;
  }

  current(): Session | null {
    return this.session;
  }

  requireSession(): Session {
    if (!this.session) throw new Error('not authenticated');
    return this.session;
  }
}

/** Seed a first OWNER account if the users table is empty (fresh install). */
export async function ensureFirstOwner(
  db: DB,
  auth: AuthService,
  defaults = { username: 'owner', displayName: 'Shop Owner', pin: '1234' },
): Promise<boolean> {
  const count = (db.prepare('SELECT count(*) c FROM users').get() as { c: number }).c;
  if (count > 0) return false;
  const pinHash = await auth.hashSecret(defaults.pin);
  db.prepare(
    `INSERT INTO users (username, display_name, pin_hash, role) VALUES (?,?,?,'OWNER')`,
  ).run(defaults.username, defaults.displayName, pinHash);
  return true;
}
