/**
 * Backups and restore.
 *
 * Backups were written faithfully but there was no way to put one back — if the
 * database died the shop needed the developer. Restore is the only destructive
 * action in the app, so these tests pin its safety rails: it refuses a corrupt
 * or foreign file, and it snapshots the current data first so restoring the
 * wrong backup is itself undoable.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import { openDatabase, type DB } from '../src/main/db/connection.js';
import { backupNow, listBackups, restoreBackup, rotateBackups } from '../src/main/db/backup.js';

let dir: string;
let dbFile: string;
let backupsPath: string;
let db: DB;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'jp-backup-'));
  dbFile = join(dir, 'shop.db');
  backupsPath = join(dir, 'backups');
  db = openDatabase({ filename: dbFile });
  db.prepare(
    `INSERT INTO users (id, username, display_name, pin_hash, role)
     VALUES (1,'owner','Owner','x','OWNER')`,
  ).run();
});

afterEach(() => {
  try {
    db.close();
  } catch {
    // already closed by a restore test
  }
  rmSync(dir, { recursive: true, force: true });
});

describe('taking backups', () => {
  it('writes a verified copy and lists it', async () => {
    const res = await backupNow(db, backupsPath, 'manual', new Date());
    expect(res.ok).toBe(true);
    expect(existsSync(res.path)).toBe(true);

    const list = listBackups(backupsPath);
    expect(list).toHaveLength(1);
    expect(list[0].kind).toBe('manual');
    expect(list[0].sizeBytes).toBeGreaterThan(0);
  });

  it('reports an empty list before anything is backed up', () => {
    expect(listBackups(backupsPath)).toEqual([]);
  });

  it('lists newest first', async () => {
    await backupNow(db, backupsPath, 'daily', new Date('2026-09-01T10:00:00Z'));
    await backupNow(db, backupsPath, 'manual', new Date('2026-09-02T10:00:00Z'));
    const list = listBackups(backupsPath);
    expect(list).toHaveLength(2);
    // mtime drives the order, so both are present and sorted descending.
    expect(list[0].takenAt >= list[1].takenAt).toBe(true);
  });

  it('keeps pre-migration backups when rotating', async () => {
    await backupNow(db, backupsPath, 'pre-migration', new Date(), 4);
    for (let i = 0; i < 9; i++) {
      await backupNow(db, backupsPath, 'daily', new Date(2026, 8, i + 1));
    }
    rotateBackups(backupsPath, 3, 2);
    const names = listBackups(backupsPath).map((b) => b.name);
    expect(names.some((n) => n.startsWith('pre-migration'))).toBe(true);
    expect(names.filter((n) => n.startsWith('daily'))).toHaveLength(3);
  });
});

describe('restoring', () => {
  it('puts the earlier data back', async () => {
    // State A: one user.
    const backup = await backupNow(db, backupsPath, 'manual', new Date());
    const name = backup.path.split(/[\\/]/).pop()!;

    // State B: a second user is added, then the shop wants A back.
    db.prepare(
      `INSERT INTO users (id, username, display_name, pin_hash, role)
       VALUES (2,'sales','Counter','x','SALESMAN')`,
    ).run();
    expect((db.prepare('SELECT count(*) c FROM users').get() as { c: number }).c).toBe(2);
    db.close();

    restoreBackup(backupsPath, name, dbFile);

    const reopened = new Database(dbFile, { readonly: true });
    expect((reopened.prepare('SELECT count(*) c FROM users').get() as { c: number }).c).toBe(1);
    reopened.close();
  });

  it('snapshots the current data first, so a wrong restore is undoable', async () => {
    const backup = await backupNow(db, backupsPath, 'manual', new Date());
    const name = backup.path.split(/[\\/]/).pop()!;
    db.prepare(
      `INSERT INTO users (id, username, display_name, pin_hash, role)
       VALUES (2,'sales','Counter','x','SALESMAN')`,
    ).run();
    db.close();

    const res = restoreBackup(backupsPath, name, dbFile);
    expect(res.safetyCopy).toMatch(/^pre-restore-/);

    // The safety copy holds the 2-user state that was just replaced.
    const safety = new Database(join(backupsPath, res.safetyCopy), { readonly: true });
    expect((safety.prepare('SELECT count(*) c FROM users').get() as { c: number }).c).toBe(2);
    safety.close();
  });

  it('clears stale WAL files that belonged to the replaced database', async () => {
    const backup = await backupNow(db, backupsPath, 'manual', new Date());
    const name = backup.path.split(/[\\/]/).pop()!;
    db.close();
    // A leftover WAL from the old database would corrupt the restored one.
    writeFileSync(`${dbFile}-wal`, 'stale');
    restoreBackup(backupsPath, name, dbFile);
    expect(existsSync(`${dbFile}-wal`)).toBe(false);
  });

  it('refuses a backup that does not exist', () => {
    expect(() => restoreBackup(backupsPath, 'nope.db', dbFile)).toThrow(/not found/);
  });

  it('refuses a corrupt backup rather than destroying a working shop', async () => {
    await backupNow(db, backupsPath, 'manual', new Date());
    const corrupt = join(backupsPath, 'manual-corrupt.db');
    writeFileSync(corrupt, 'this is not a database');
    db.close();

    expect(() => restoreBackup(backupsPath, 'manual-corrupt.db', dbFile)).toThrow();
    // The live database must be untouched, and no safety copy written for a
    // restore that never happened.
    const reopened = new Database(dbFile, { readonly: true });
    expect((reopened.prepare('SELECT count(*) c FROM users').get() as { c: number }).c).toBe(1);
    reopened.close();
    expect(readdirSync(backupsPath).some((f) => f.startsWith('pre-restore'))).toBe(false);
  });

  it('cannot be pointed outside the backups folder', async () => {
    await backupNow(db, backupsPath, 'manual', new Date());
    // A traversal attempt is reduced to a bare filename, which will not exist.
    expect(() => restoreBackup(backupsPath, '../../../etc/passwd', dbFile)).toThrow(/not found/);
  });
});
