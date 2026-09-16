import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, writeFileSync, readdirSync, statSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openDatabase, type DB } from '../src/main/db/connection.js';
import { backupNow, copyBackupOffsite, rotateOffsite } from '../src/main/db/backup.js';

let db: DB;
let root: string;
let backupsDir: string;
let offsiteDir: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'jp-offsite-'));
  backupsDir = join(root, 'backups');
  offsiteDir = join(root, 'usb');
  db = openDatabase({ filename: join(root, 'shop.db') });
  db.prepare(
    `INSERT INTO users (id, username, display_name, pin_hash, role) VALUES (1,'owner','Owner','x','OWNER')`,
  ).run();
});

afterEach(() => {
  db.close();
  rmSync(root, { recursive: true, force: true });
});

describe('copyBackupOffsite', () => {
  it('copies a verified backup and verifies the copy', async () => {
    const res = await backupNow(db, backupsDir, 'manual', new Date());
    expect(res.ok).toBe(true);

    const out = copyBackupOffsite(res.path, offsiteDir);
    expect(out.ok).toBe(true);
    expect(out.path).not.toBeNull();
    expect(existsSync(out.path!)).toBe(true);
    // The copy must itself be a usable database, not just bytes on disk.
    const copy = openDatabase({ filename: out.path! });
    expect((copy.prepare('SELECT COUNT(*) n FROM users').get() as { n: number }).n).toBe(1);
    copy.close();
  });

  it('creates the destination folder when it does not exist yet', async () => {
    const res = await backupNow(db, backupsDir, 'manual', new Date());
    const nested = join(offsiteDir, 'deep', 'nested');
    expect(copyBackupOffsite(res.path, nested).ok).toBe(true);
    expect(existsSync(nested)).toBe(true);
  });

  it('reports rather than throws when no folder is configured', () => {
    const out = copyBackupOffsite('anything.db', '   ');
    expect(out.ok).toBe(false);
    expect(out.reason).toMatch(/No off-site folder/);
  });

  it('reports rather than throws when the backup is missing', () => {
    const out = copyBackupOffsite(join(root, 'nope.db'), offsiteDir);
    expect(out.ok).toBe(false);
    expect(out.reason).toMatch(/missing/i);
  });

  it('discards a corrupt copy rather than reporting success', () => {
    // A truncated write to a removable drive is exactly what this guards.
    const fake = join(root, 'fake.db');
    writeFileSync(fake, 'this is not a sqlite database');

    const out = copyBackupOffsite(fake, offsiteDir);
    expect(out.ok).toBe(false);
    // Nothing corrupt is left behind pretending to be a backup.
    expect(readdirSync(offsiteDir).filter((f) => f.endsWith('.db'))).toEqual([]);
  });
});

describe('rotateOffsite', () => {
  it('keeps only the newest copies so a USB stick cannot fill up', async () => {
    const res = await backupNow(db, backupsDir, 'manual', new Date());
    // Six copies under distinct names, aged so the ordering is unambiguous.
    for (let i = 0; i < 6; i++) {
      const dest = join(offsiteDir, `manual-${i}.db`);
      copyBackupOffsite(res.path, offsiteDir);
      const copied = join(offsiteDir, res.path.split(/[\\/]/).pop()!);
      if (existsSync(copied)) {
        writeFileSync(dest, Buffer.from([]));
        rmSync(copied, { force: true });
      }
      const t = new Date(Date.now() - (6 - i) * 60_000);
      utimesSync(dest, t, t);
    }

    const removed = rotateOffsite(offsiteDir, 3);
    const left = readdirSync(offsiteDir).filter((f) => f.endsWith('.db'));
    expect(left).toHaveLength(3);
    expect(removed).toHaveLength(3);
    // The three kept are the newest three.
    const times = left.map((f) => statSync(join(offsiteDir, f)).mtimeMs).sort((a, b) => a - b);
    expect(times[0]).toBeGreaterThan(Date.now() - 4 * 60_000);
  });

  it('is a no-op on a folder that does not exist', () => {
    expect(rotateOffsite(join(root, 'never'), 3)).toEqual([]);
  });
});
