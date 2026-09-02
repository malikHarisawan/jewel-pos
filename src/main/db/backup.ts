/**
 * Local backups using better-sqlite3's online backup (safe while the DB is open;
 * no risk of copying a half-written WAL). Backups are integrity-checked and
 * rotated. Pre-migration backups are kept forever; dailies/weeklies rotate.
 */
import { mkdirSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
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
