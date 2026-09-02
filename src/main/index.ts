/** Electron main process entry: single-instance lock, DB boot (backup ->
 * migrate), auth + IPC wiring, then the window. */
import { app, BrowserWindow, dialog } from 'electron';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { openDatabase, type DB } from './db/connection.js';
import { backupNow, rotateBackups } from './db/backup.js';
import { AuthService, ensureFirstOwner } from './auth/authService.js';
import { LicenseService } from './license/licenseService.js';
import { registerIpc } from './ipc/register.js';
import type { AppContext } from './ipc/router.js';
import { dataDir, dbPath, backupsDir } from './paths.js';

let db: DB;
let auth: AuthService;
let license: LicenseService;
let mainWindow: BrowserWindow | null = null;

const BACKUP_INTERVAL_MS = 4 * 60 * 60 * 1000; // every 4 hours while running
let backupTimer: NodeJS.Timeout | null = null;

async function bootDatabase(): Promise<void> {
  mkdirSync(dataDir(), { recursive: true });

  db = openDatabase({
    filename: dbPath(),
    beforeMigrate: (handle, pending) => {
      if (pending) {
        const version = handle.pragma('user_version', { simple: true }) as number;
        // Fire-and-await via a synchronous shim: backup() is async, but boot is
        // allowed to block here — the window hasn't opened yet.
        void backupNow(handle, backupsDir(), 'pre-migration', new Date(), version);
      }
    },
  });

  auth = new AuthService(db);
  license = new LicenseService(db);
  license.getInfo(); // sets trial_start on first boot
  const seeded = await ensureFirstOwner(db, auth);
  if (seeded) {
    console.log('[boot] seeded default owner account (username: owner, pin: 1234)');
  }
}

function scheduleBackups(): void {
  const run = async () => {
    try {
      await backupNow(db, backupsDir(), 'daily', new Date());
      rotateBackups(backupsDir());
    } catch (err) {
      console.error('[backup] scheduled backup failed', err);
    }
  };
  backupTimer = setInterval(run, BACKUP_INTERVAL_MS);
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    show: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.cjs'),
      sandbox: false,
    },
  });

  mainWindow.on('ready-to-show', () => mainWindow?.show());

  if (process.env['ELECTRON_RENDERER_URL']) {
    void mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL']);
  } else {
    void mainWindow.loadFile(join(__dirname, '../renderer/index.html'));
  }
}

function getContext(): AppContext {
  return { db, auth, license, session: auth.current() };
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(async () => {
    try {
      await bootDatabase();
    } catch (err) {
      dialog.showErrorBox(
        'Database error',
        `The database could not be opened or migrated. The app will close.\n\n${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      app.quit();
      return;
    }

    registerIpc(getContext);
    scheduleBackups();
    createWindow();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', async () => {
    if (backupTimer) clearInterval(backupTimer);
    try {
      db.pragma('wal_checkpoint(TRUNCATE)');
      await backupNow(db, backupsDir(), 'daily', new Date());
      rotateBackups(backupsDir());
      db.close();
    } catch (err) {
      console.error('[shutdown] final backup failed', err);
    }
    if (process.platform !== 'darwin') app.quit();
  });
}
