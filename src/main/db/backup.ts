/**
 * Local backups using better-sqlite3's online backup (safe while the DB is open;
 * no risk of copying a half-written WAL). Backups are integrity-checked and
 * rotated. Pre-migration backups are kept forever; dailies/weeklies rotate.
 */
import {
  mkdirSync,
  readdirSync,
  statSync,
  unlinkSync,
  existsSync,
  copyFileSync,
} from 'node:fs';
import { join, basename } from 'node:path';
import Database from 'better-sqlite3';
import type { DB } from './connection.js';

export interface BackupResult {
  path: string;
  ok: boolean;
}

function stamp(now: Date): string {
  return now.toISOString().replace(/[:.]/g, '-');
}

/** Take an online backup to `dir`, verify it, delete it if corrupt. */
export async function backupNow(
  db: DB,
  dir: string,
  kind: 'daily' | 'weekly' | 'pre-migration' | 'manual',
  now: Date,
  version?: number,
): Promise<BackupResult> {
  mkdirSync(dir, { recursive: true });
  const versionTag = version != null ? `-v${version}` : '';
  const file = join(dir, `${kind}${versionTag}-${stamp(now)}.db`);

  await db.backup(file);

  const check = new Database(file, { readonly: true });
  try {
    const res = check.pragma('integrity_check', { simple: true }) as string;
    if (res !== 'ok') {
      check.close();
      unlinkSync(file);
      return { path: file, ok: false };
    }
  } finally {
    check.close();
  }
  return { path: file, ok: true };
}

/**
 * Keep the most recent `keepDaily` daily and `keepWeekly` weekly backups;
 * pre-migration and manual backups are never rotated out.
 */
export function rotateBackups(dir: string, keepDaily = 7, keepWeekly = 8): string[] {
  const removed: string[] = [];
  const prune = (prefix: string, keep: number) => {
    const files = readdirSync(dir)
      .filter((f) => f.startsWith(prefix) && f.endsWith('.db'))
      .map((f) => ({ f, m: statSync(join(dir, f)).mtimeMs }))
      .sort((a, b) => b.m - a.m);
    for (const { f } of files.slice(keep)) {
      unlinkSync(join(dir, f));
      removed.push(f);
    }
  };
  prune('daily-', keepDaily);
  prune('weekly-', keepWeekly);
  return removed;
}

export interface BackupFile {
  /** File name only — the UI never needs the absolute path. */
  name: string;
  kind: string;
  sizeBytes: number;
  takenAt: string;
}

/** Every backup on disk, newest first. */
export function listBackups(dir: string): BackupFile[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.db'))
    .map((f) => {
      const st = statSync(join(dir, f));
      return {
        name: f,
        kind: f.split('-')[0],
        sizeBytes: st.size,
        takenAt: new Date(st.mtimeMs).toISOString(),
      };
    })
    .sort((a, b) => b.takenAt.localeCompare(a.takenAt));
}

/**
 * Replace the live database with a backup.
 *
 * Restoring is the most destructive thing the app can do, so it is deliberate
 * about order:
 *   1. reject a file that is not in the backups directory (no path traversal),
 *   2. reject a backup that does not open or fails its integrity check,
 *   3. take a `pre-restore` snapshot of the CURRENT database, so a restore of
 *      the wrong file is itself undoable,
 *   4. only then overwrite.
 *
 * The caller must close the live DB handle first and quit/reopen after — the
 * app restarts rather than trying to hot-swap an open connection.
 */
export function restoreBackup(
  backupsDirPath: string,
  fileName: string,
  livePath: string,
): { restoredFrom: string; safetyCopy: string } {
  // basename() strips any "../" a caller might send.
  const safeName = basename(fileName);
  const src = join(backupsDirPath, safeName);
  if (!existsSync(src)) throw new Error(`backup "${safeName}" not found`);

  // Never restore a corrupt file over a working shop database.
  const probe = new Database(src, { readonly: true });
  try {
    const res = probe.pragma('integrity_check', { simple: true }) as string;
    if (res !== 'ok') throw new Error(`backup "${safeName}" failed its integrity check`);
  } finally {
    probe.close();
  }

  // Snapshot what is about to be replaced, so this is reversible.
  const stampNow = new Date().toISOString().replace(/[:.]/g, '-');
  const safety = join(backupsDirPath, `pre-restore-${stampNow}.db`);
  if (existsSync(livePath)) copyFileSync(livePath, safety);

  copyFileSync(src, livePath);
  // WAL/SHM belong to the replaced database; leaving them would corrupt the
  // restored file on next open.
  for (const suffix of ['-wal', '-shm']) {
    const side = `${livePath}${suffix}`;
    if (existsSync(side)) unlinkSync(side);
  }

  return { restoredFrom: safeName, safetyCopy: basename(safety) };
}
