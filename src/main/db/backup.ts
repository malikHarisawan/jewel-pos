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

  if (!verifyDatabaseFile(file)) {
    unlinkSync(file);
    return { path: file, ok: false };
  }
  return { path: file, ok: true };
}

/**
 * True when `file` opens as a SQLite database and passes its integrity check.
 *
 * A corrupt or truncated file does not come back as a failing check — opening
 * it or running the pragma THROWS ("file is not a database"). Treating only the
 * non-'ok' return as failure would let a junk file escape as an exception and,
 * worse, leave it on disk looking like a usable backup. Both outcomes are
 * failures and are reported the same way.
 */
function verifyDatabaseFile(file: string): boolean {
  let check: Database.Database | undefined;
  try {
    check = new Database(file, { readonly: true });
    return (check.pragma('integrity_check', { simple: true }) as string) === 'ok';
  } catch {
    return false;
  } finally {
    try {
      check?.close();
    } catch {
      // Closing a handle that never fully opened is not itself a failure.
    }
  }
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

/**
 * Copy a verified backup to a second location — a USB stick, or a folder that a
 * cloud client (Drive, Dropbox, OneDrive) syncs.
 *
 * A shop's entire book living on one PC in one shop is the fear that sells this
 * feature, so the job here is narrow and reliable: take a backup that has
 * already passed its integrity check and put a copy somewhere the fire and the
 * thief are not. Nothing here creates a backup; it only mirrors a good one.
 *
 * Failure is never fatal to the caller. A missing USB stick is the normal case
 * — the drive is unplugged most of the time — so this reports and moves on
 * rather than turning a successful local backup into an error.
 */
export interface OffsiteResult {
  ok: boolean;
  path: string | null;
  reason: string | null;
}

export function copyBackupOffsite(sourcePath: string, destDir: string): OffsiteResult {
  if (!destDir.trim()) return { ok: false, path: null, reason: 'No off-site folder set.' };
  if (!existsSync(sourcePath)) {
    return { ok: false, path: null, reason: 'The backup file is missing.' };
  }
  try {
    mkdirSync(destDir, { recursive: true });
    const dest = join(destDir, basename(sourcePath));
    copyFileSync(sourcePath, dest);
    // Verify the copy independently. A truncated write to a removable drive is
    // exactly the failure this feature exists to protect against, and a corrupt
    // off-site copy that reports success is worse than none at all.
    if (!verifyDatabaseFile(dest)) {
      try {
        unlinkSync(dest);
      } catch {
        // Best effort: a file we cannot delete is still reported as a failure.
      }
      return { ok: false, path: null, reason: 'The copy did not verify and was discarded.' };
    }
    return { ok: true, path: dest, reason: null };
  } catch (err) {
    // Unplugged drive, full disk, permissions: all normal, none fatal.
    return {
      ok: false,
      path: null,
      reason: err instanceof Error ? err.message : 'Could not write to that folder.',
    };
  }
}

/** Keep only the newest `keep` off-site copies, so a USB stick cannot fill up. */
export function rotateOffsite(destDir: string, keep = 14): string[] {
  if (!existsSync(destDir)) return [];
  const removed: string[] = [];
  const files = readdirSync(destDir)
    .filter((f) => f.endsWith('.db'))
    .map((f) => ({ f, t: statSync(join(destDir, f)).mtimeMs }))
    .sort((a, b) => b.t - a.t);
  for (const { f } of files.slice(keep)) {
    try {
      unlinkSync(join(destDir, f));
      removed.push(f);
    } catch {
      // A locked file on a removable drive is not worth failing a backup over.
    }
  }
  return removed;
}
