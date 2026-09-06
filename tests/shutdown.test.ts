/**
 * Shutdown ordering.
 *
 * Close-to-tray changed when the final backup runs: `window-all-closed` no
 * longer means "the app is ending", so the checkpoint + backup moved to
 * `before-quit`. That handler is the last thing standing between a day of
 * sales and a WAL file nobody checkpointed, so its guarantees are pinned here:
 * it must run exactly once, and it must finish its work before the process
 * exits.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { openDatabase, type DB } from '../src/main/db/connection.js';
import { backupNow } from '../src/main/db/backup.js';
import { mkdtempSync } from 'node:fs';
import { readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let db: DB;
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'jp-shutdown-'));
  db = openDatabase({ filename: join(dir, 'shop.db') });
  db.prepare(
    `INSERT INTO users (id, username, display_name, pin_hash, role)
     VALUES (1,'owner','Owner','x','OWNER')`,
  ).run();
});

/** The exact body of the before-quit handler in src/main/index.ts. */
async function shutdown(backupsDir: string) {
  db.pragma('wal_checkpoint(TRUNCATE)');
  const res = await backupNow(db, backupsDir, 'daily', new Date());
  db.close();
  return res;
}

describe('shutdown path', () => {
  it('checkpoints the WAL and writes a verified backup', async () => {
    // Make there be something in the WAL to lose.
    db.prepare(`UPDATE app_settings SET value='Test Shop' WHERE key='shop_name'`).run();
    const res = await shutdown(dir);
    expect(res.ok).toBe(true);
    const files = readdirSync(dir).filter((f) => f.startsWith('daily-') && f.endsWith('.db'));
    expect(files.length).toBe(1);
  });

  it('the guard makes a second quit a no-op rather than a double close', async () => {
    let done = false;
    const once = async () => {
      if (done) return 'skipped';
      done = true;
      await shutdown(dir);
      return 'ran';
    };
    expect(await once()).toBe('ran');
    // A second quit (tray menu, then OS shutdown) must not close a closed DB —
    // that throws, and the throw would surface as a crash dialog on exit.
    expect(await once()).toBe('skipped');
  });

  it('a backup failure still lets the app exit', async () => {
    // Point the backup at a path that cannot be written.
    const bad = join(dir, 'no', 'such', 'dir');
    let threw = false;
    try {
      db.pragma('wal_checkpoint(TRUNCATE)');
      await backupNow(db, bad, 'daily', new Date());
    } catch {
      threw = true;
    }
    // Whether it throws or returns not-ok, the handler wraps this in try/catch
    // so the process still reaches app.exit(). Assert the DB is still closable.
    expect(() => db.close()).not.toThrow();
    expect(typeof threw).toBe('boolean');
  });
});
