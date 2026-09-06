/** System tray presence.
 *
 * A POS is open from morning to close. The tray keeps the till one click away
 * without leaving a window in the way, and — more importantly — stops a stray
 * click on the X from shutting the shop's register down mid-transaction.
 *
 * Quitting is deliberate here: only the tray's Quit item, or a real OS
 * shutdown, ends the process. Everything else hides. See `allowQuit`.
 */
import { app, Menu, Tray, nativeImage, type BrowserWindow } from 'electron';
import { join } from 'node:path';
import { existsSync } from 'node:fs';

let tray: Tray | null = null;
/** Set once the user genuinely asks to quit, so `close` stops hiding. */
let quitting = false;

export function isQuitting(): boolean {
  return quitting;
}

/** Mark the app as really shutting down, then quit. */
export function quitApp(): void {
  quitting = true;
  app.quit();
}

/**
 * Packaged, resources sit beside the asar; in dev they are in the repo. Resolve
 * against both so the tray icon is not missing during development (an empty
 * image silently produces an invisible tray item, which looks like a crash).
 */
function iconPath(file: string): string | null {
  const candidates = [
    join(process.resourcesPath ?? '', file),
    join(app.getAppPath(), 'resources', file),
    join(__dirname, '../../resources', file),
  ];
  return candidates.find((p) => p && existsSync(p)) ?? null;
}

export function createTray(getWindow: () => BrowserWindow | null, shopName: () => string): void {
  if (tray) return;

  // The tray art is a separate, container-less mark: the app icon's rounded
  // square eats most of the pixels at 16px and the gem turns to a dark blob.
  const file = iconPath('tray.ico') ?? iconPath('icon.ico');
  const image = file ? nativeImage.createFromPath(file) : nativeImage.createEmpty();
  tray = new Tray(image);

  const show = () => {
    const win = getWindow();
    if (!win) return;
    if (win.isMinimized()) win.restore();
    if (!win.isVisible()) win.show();
    win.focus();
  };

  const menu = Menu.buildFromTemplate([
    { label: 'Open Jewel POS', click: show },
    { type: 'separator' },
    { label: 'Quit Jewel POS', click: quitApp },
  ]);

  tray.setToolTip(`Jewel POS — ${shopName()}`);
  tray.setContextMenu(menu);
  // Double-click is the Windows convention for "open"; single click is a
  // common expectation too, so both are wired.
  tray.on('click', show);
  tray.on('double-click', show);
}

/** Keep the hover text in step with a shop-name change in Settings. */
export function updateTrayTooltip(shopName: string): void {
  tray?.setToolTip(`Jewel POS — ${shopName}`);
}

export function destroyTray(): void {
  tray?.destroy();
  tray = null;
}

/**
 * Reflect the launch-at-startup preference into the OS.
 *
 * `openAsHidden` is macOS-only; on Windows the flag is passed as an argument so
 * the app can start parked in the tray instead of throwing a window in the
 * shop's face while the machine is still booting.
 */
export function applyLaunchAtStartup(enabled: boolean): void {
  // Never touch the registry from a dev run — it would register the Electron
  // binary and the dev path, leaving a broken startup entry behind.
  if (!app.isPackaged) return;
  app.setLoginItemSettings({
    openAtLogin: enabled,
    openAsHidden: true,
    args: enabled ? ['--hidden'] : [],
  });
}

/** True when the app was started by the OS at login (so it should stay hidden). */
export function startedHidden(): boolean {
  if (process.argv.includes('--hidden')) return true;
  try {
    return app.getLoginItemSettings().wasOpenedAtLogin === true;
  } catch {
    return false;
  }
}
