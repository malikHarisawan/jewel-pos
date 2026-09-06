/**
 * Tray and startup preferences.
 *
 * These two settings are unusual: they are rows in the database AND state in
 * the operating system. A toggle that saves the row but never reaches the OS
 * looks like it worked and does nothing, so the handler's side effect is
 * pinned here alongside the plain read/write.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { openDatabase, type DB } from '../src/main/db/connection.js';
import { getSettings, updateSettings } from '../src/main/services/settingsService.js';
import { LATEST_VERSION } from '../src/main/db/migrations/index.js';

let db: DB;

beforeEach(() => {
  db = openDatabase({ filename: ':memory:' });
  // app_settings.updated_by is a foreign key, so writes need a real user.
  db.prepare(
    `INSERT INTO users (id, username, display_name, pin_hash, role)
     VALUES (1,'owner','Owner','x','OWNER')`,
  ).run();
});

describe('tray + startup settings', () => {
  it('migration 0010 is registered and applied', () => {
    expect(LATEST_VERSION).toBeGreaterThanOrEqual(10);
    expect(db.pragma('user_version', { simple: true })).toBe(LATEST_VERSION);
  });

  it('defaults: parks in the tray, does NOT add itself to startup', () => {
    const s = getSettings(db);
    // Closing the window should not shut the till down...
    expect(s.close_to_tray).toBe('1');
    // ...but installing software must never silently claim a machine's startup.
    expect(s.launch_at_startup).toBe('0');
  });

  it('round-trips both toggles', () => {
    const next = updateSettings(db, 1, { close_to_tray: '0', launch_at_startup: '1' });
    expect(next.close_to_tray).toBe('0');
    expect(next.launch_at_startup).toBe('1');
    // and survives a fresh read, i.e. it really hit the table
    expect(getSettings(db).launch_at_startup).toBe('1');
  });

  it('leaves the other settings alone', () => {
    const before = getSettings(db).max_discount_pct_salesman;
    updateSettings(db, 1, { close_to_tray: '0' });
    expect(getSettings(db).max_discount_pct_salesman).toBe(before);
  });

  it('an existing install keeps its own choice when migrations re-run', () => {
    updateSettings(db, 1, { close_to_tray: '0' });
    // 0010 uses ON CONFLICT DO NOTHING, so re-applying must not reset the shop
    // back to the default.
    db.exec(`INSERT INTO app_settings (key, value) VALUES ('close_to_tray','1')
             ON CONFLICT(key) DO NOTHING`);
    expect(getSettings(db).close_to_tray).toBe('0');
  });
});

describe('settings.update pushes desktop prefs to the host', () => {
  /** Minimal stand-in for the Electron side of AppContext. */
  function ctxWith(sink: unknown[]) {
    return {
      db,
      auth: { requireSession: () => ({ userId: 1, role: 'OWNER' as const }) },
      platform: { applyDesktopPrefs: (p: unknown) => sink.push(p) },
    };
  }

  it('hands the host booleans and the shop name', async () => {
    const { handlers } = await import('../src/main/ipc/handlers.js');
    const seen: unknown[] = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await handlers['settings.update'](ctxWith(seen) as any, {
      close_to_tray: '0',
      launch_at_startup: '1',
    });
    expect(seen).toEqual([
      { closeToTray: false, launchAtStartup: true, shopName: getSettings(db).shop_name },
    ]);
  });

  it('does not crash when the host has no desktop (the HTTP harness)', async () => {
    const { handlers } = await import('../src/main/ipc/handlers.js');
    const bare = {
      db,
      auth: { requireSession: () => ({ userId: 1, role: 'OWNER' as const }) },
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const out = await handlers['settings.update'](bare as any, { close_to_tray: '0' });
    expect(out.close_to_tray).toBe('0');
  });
});
