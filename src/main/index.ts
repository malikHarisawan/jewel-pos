/** Electron main process entry: single-instance lock, DB boot (backup ->
 * migrate), auth + IPC wiring, then the window. */
import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';
import { mkdirSync } from 'node:fs';
import { join, basename } from 'node:path';
import { openDatabaseAsync, type DB } from './db/connection.js';
import { backupNow, rotateBackups } from './db/backup.js';
import { AuthService, ensureFirstOwner } from './auth/authService.js';
import { LicenseService } from './license/licenseService.js';
import { registerIpc } from './ipc/register.js';
import { initAutoUpdate } from './updater.js';
import {
  createTray,
  destroyTray,
  isQuitting,
  quitApp,
  applyLaunchAtStartup,
  startedHidden,
  updateTrayTooltip,
} from './tray.js';
import { getSettings } from './services/settingsService.js';
import type { AppContext } from './ipc/router.js';
import { dataDir, dbPath, backupsDir, exportsDir } from './paths.js';

/**
 * Redirect every app data location to a throwaway directory.
 *
 * The UI smoke test drives the real application, and one of the things it does
 * is change the owner's PIN. Pointed at the shop's own folder that is not a
 * test — it is a live edit that locks the counter out with the wrong PIN.
 * Honoured ONLY in development: a packaged build ignores it, so nothing a
 * shop's machine ever sees can be redirected by an environment variable.
 */
if (!app.isPackaged && process.env['JP_USER_DATA']) {
  app.setPath('userData', process.env['JP_USER_DATA']);
}

let db: DB;
let auth: AuthService;
let license: LicenseService;
let mainWindow: BrowserWindow | null = null;
/** Cached so the window's `close` handler stays synchronous. */
let closeToTray = true;

const BACKUP_INTERVAL_MS = 4 * 60 * 60 * 1000; // every 4 hours while running
let backupTimer: NodeJS.Timeout | null = null;

async function bootDatabase(): Promise<void> {
  mkdirSync(dataDir(), { recursive: true });

  db = await openDatabaseAsync({
    filename: dbPath(),
    beforeMigrate: async (handle, pending) => {
      if (!pending) return;
      const version = handle.pragma('user_version', { simple: true }) as number;
      // Awaited, not fire-and-forget: this is the copy you fall back on if the
      // migration corrupts something, so it must be on disk and verified BEFORE
      // the schema changes. Blocking here is fine — no window has opened yet.
      const res = await backupNow(handle, backupsDir(), 'pre-migration', new Date(), version);
      if (!res.ok) {
        throw new Error(
          'the safety backup taken before upgrading failed its integrity check; ' +
            'the database was left untouched',
        );
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
    /* Frameless: the shell already draws its own title bar in the app's palette,
       and the stock Windows chrome sat above it as a second, mismatched bar.
       The renderer supplies the drag region and the window buttons. */
    frame: false,
    backgroundColor: '#3a2317',
    webPreferences: {
      preload: join(__dirname, '../preload/index.cjs'),
      sandbox: false,
    },
  });

  // Frameless windows lose the OS maximise/restore affordance, so the custom
  // button has to be told which state it is in.
  const emitWindowState = () => {
    mainWindow?.webContents.send('window:state', {
      maximized: mainWindow.isMaximized(),
    });
  };
  mainWindow.on('maximize', emitWindowState);
  mainWindow.on('unmaximize', emitWindowState);

  // Launched by Windows at login: come up parked in the tray so the shop's
  // machine finishes booting without a window in the way.
  const hidden = startedHidden();
  mainWindow.on('ready-to-show', () => {
    if (!hidden) mainWindow?.show();
  });

  // The X button parks the till rather than closing it. Without this a stray
  // click mid-sale shuts the register down. Quit stays available from the tray.
  mainWindow.on('close', (e) => {
    if (isQuitting()) return;
    if (!closeToTray) return;
    e.preventDefault();
    mainWindow?.hide();
  });

  if (process.env['ELECTRON_RENDERER_URL']) {
    void mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL']);
  } else {
    void mainWindow.loadFile(join(__dirname, '../renderer/index.html'));
  }
}

/** Minimise / maximise / close for the custom title bar. Kept off the contract
 * router: these are window chrome, not application channels, and they carry no
 * data and no role guard. Close still honours the close-to-tray preference, so
 * the custom button behaves exactly as the OS one did. */
function registerWindowControls(): void {
  ipcMain.on('window:minimize', () => mainWindow?.minimize());
  ipcMain.on('window:toggle-maximize', () => {
    if (!mainWindow) return;
    if (mainWindow.isMaximized()) mainWindow.unmaximize();
    else mainWindow.maximize();
  });
  ipcMain.on('window:close', () => mainWindow?.close());
  ipcMain.handle('window:is-maximized', () => mainWindow?.isMaximized() ?? false);
}

function getContext(): AppContext {
  return {
    db,
    auth,
    license,
    session: auth.current(),
    platform: {
      backupsDir: backupsDir(),
      exportsDir: exportsDir(),
      dbPath: dbPath(),
      revealExport: (folder: string) => {
        // basename() keeps a crafted folder name from walking out of the
        // exports tree and revealing an arbitrary directory.
        void shell.openPath(join(exportsDir(), basename(folder)));
      },
      relaunch: () => {
        app.relaunch();
        // Give the reply time to reach the renderer before the process dies,
        // so the user sees the confirmation rather than a silent restart.
        setTimeout(() => app.exit(0), 800);
      },
      applyDesktopPrefs: ({ closeToTray: toTray, launchAtStartup, shopName }) => {
        closeToTray = toTray;
        applyLaunchAtStartup(launchAtStartup);
        updateTrayTooltip(shopName);
      },
    },
  };
}

/**
 * A throw before the first window exists kills the process with no window, no
 * console and no log — the shop sees the app "not open" and has nothing to send
 * you. Catch it and show a dialog instead, so a failed launch is always
 * diagnosable on the shop's own PC.
 */
process.on('uncaughtException', (err) => {
  try {
    dialog.showErrorBox(
      'Jewel POS could not start',
      `${err instanceof Error ? err.stack ?? err.message : String(err)}`,
    );
  } catch {
    // Dialog is unavailable this early; the log line below is the fallback.
  }
  console.error('[startup] fatal', err);
  app.exit(1);
});

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      // The first instance may be parked in the tray, so showing comes before
      // focusing — otherwise launching from the Start menu appears to do nothing.
      if (mainWindow.isMinimized()) mainWindow.restore();
      if (!mainWindow.isVisible()) mainWindow.show();
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

    // Preferences that change OS-level behaviour are read once at boot and
    // re-applied whenever Settings writes them (see settings.update below).
    try {
      const s = getSettings(db);
      closeToTray = s.close_to_tray !== '0';
      applyLaunchAtStartup(s.launch_at_startup === '1');
    } catch (err) {
      console.error('[boot] could not read tray/startup settings', err);
    }

    registerIpc(getContext);
    registerWindowControls();
    scheduleBackups();
    createWindow();
    createTray(
      () => mainWindow,
      () => {
        try {
          return getSettings(db).shop_name;
        } catch {
          return '';
        }
      },
    );
    initAutoUpdate();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  // With close-to-tray the window can close while the app keeps running, so the
  // final backup can no longer hang off `window-all-closed` — it would fire
  // while the till is still open, or (when hidden) never fire at all. It moves
  // to `before-quit`, guarded so it runs exactly once even if quit is requested
  // twice (tray menu, then OS shutdown).
  let shutdownDone = false;
  app.on('before-quit', (e) => {
    if (shutdownDone) return;
    e.preventDefault();
    shutdownDone = true;
    if (backupTimer) clearInterval(backupTimer);

    void (async () => {
      try {
        db.pragma('wal_checkpoint(TRUNCATE)');
        await backupNow(db, backupsDir(), 'daily', new Date());
        rotateBackups(backupsDir());
        db.close();
      } catch (err) {
        console.error('[shutdown] final backup failed', err);
      }
      destroyTray();
      // exit(), not quit(): the work above is done and quit() would re-enter
      // this handler's event on some platforms.
      app.exit(0);
    })();
  });

  app.on('window-all-closed', () => {
    // Closing the last window only ends the app when the tray is not holding
    // it open. macOS keeps its own convention of staying resident.
    if (closeToTray) return;
    if (process.platform !== 'darwin') quitApp();
  });
}
