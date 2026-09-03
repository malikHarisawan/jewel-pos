/**
 * SQLite connection + migration runner. Main-process only (better-sqlite3 is
 * synchronous native code). The migration runner is exported separately so
 * tests can spin up an in-memory or temp-file DB without Electron.
 */
import Database from 'better-sqlite3';
import { MIGRATIONS } from './migrations/index.js';

export type DB = Database.Database;

/** Apply the standard PRAGMAs for a shop PC: WAL + power-loss safety. */
export function applyPragmas(db: DB): void {
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
}

/**
 * Run all migrations whose version exceeds the DB's current user_version.
 * Each migration runs in its own transaction; a failure rolls back that
 * migration and rethrows, leaving user_version at the last good state.
 */
export function runMigrations(db: DB): { from: number; to: number; applied: string[] } {
  const from = db.pragma('user_version', { simple: true }) as number;
  const applied: string[] = [];

  for (const m of MIGRATIONS) {
    if (m.version <= from) continue;
    const tx = db.transaction(() => {
      db.exec(m.sql);
      db.pragma(`user_version = ${m.version}`);
    });
    tx();
    applied.push(m.name);
  }

  const to = db.pragma('user_version', { simple: true }) as number;
  return { from, to, applied };
}

export interface OpenOptions {
  /** Absolute path, or ':memory:' for tests. */
  filename: string;
  /** Called after PRAGMAs but before migrations — e.g. to take a backup. */
  beforeMigrate?: (db: DB, pending: boolean) => void;
}

/** Open a DB, apply pragmas, optionally back up, then migrate. */
export function openDatabase(opts: OpenOptions): DB {
  const db = new Database(opts.filename);
  applyPragmas(db);

  if (opts.beforeMigrate) {
    opts.beforeMigrate(db, hasPendingMigrations(db));
  }

  runMigrations(db);
  return db;
}

/** Whether any migration is newer than what this DB has applied. */
export function hasPendingMigrations(db: DB): boolean {
  const current = db.pragma('user_version', { simple: true }) as number;
  return MIGRATIONS.some((m) => m.version > current);
}

export interface OpenAsyncOptions {
  filename: string;
  /**
   * Awaited before migrations run. The sync `beforeMigrate` above cannot be
   * awaited, so a pre-migration backup started there might still be writing
   * when the schema changes underneath it — precisely the backup you need if
   * the migration goes wrong.
   */
  beforeMigrate?: (db: DB, pending: boolean) => Promise<void>;
}

/** `openDatabase` for callers that need the pre-migrate hook to COMPLETE. */
export async function openDatabaseAsync(opts: OpenAsyncOptions): Promise<DB> {
  const db = new Database(opts.filename);
  applyPragmas(db);

  if (opts.beforeMigrate) {
    await opts.beforeMigrate(db, hasPendingMigrations(db));
  }

  runMigrations(db);
  return db;
}
