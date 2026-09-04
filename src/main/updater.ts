/**
 * Auto-update, wired defensively.
 *
 * `electron-updater` was a dependency that nothing imported, so shipping a fix
 * meant reinstalling by hand on every shop's PC. It is now wired — but only
 * when a real feed exists.
 *
 * A jewellery counter is the wrong place for a surprise restart, so this checks
 * and DOWNLOADS in the background and then waits: the update is installed when
 * the shop closes the app, never mid-sale. Nothing here can interrupt a
 * checkout.
 */
import { app } from 'electron';
import electronUpdater from 'electron-updater';

/**
 * `electron-updater` builds its updater the first time `autoUpdater` is READ,
 * and that constructor calls `app.getVersion()`. Destructuring it at module
 * scope therefore ran before Electron was ready and crashed the packaged app
 * on launch — silently, because the crash happened before any window or log
 * existed. Reading it lazily, inside a function called after `whenReady`, is
 * what keeps that constructor on the right side of app startup.
 */
function updater(): typeof electronUpdater.autoUpdater {
  return electronUpdater.autoUpdater;
}

/** The placeholder shipped in electron-builder.yml. Treated as "no feed". */
const PLACEHOLDER_HOSTS = ['example.com', 'localhost'];

/**
 * Whether a usable update feed is configured. Without this guard the updater
 * would fire a request at example.com on every boot of an offline shop PC and
 * log a failure the shopkeeper cannot act on.
 */
function hasRealFeed(): boolean {
  try {
    const feed = updater().getFeedURL();
    if (!feed) return false;
    const host = new URL(feed).hostname;
    return !PLACEHOLDER_HOSTS.includes(host);
  } catch {
    // No feed configured, or an unparseable one: either way, nothing to talk to.
    return false;
  }
}

/**
 * Start background update checks. Safe to call unconditionally: it is a no-op
 * in development, and a no-op when no real release channel is configured.
 */
export function initAutoUpdate(): void {
  if (!app.isPackaged) return; // dev builds are not signed and have no feed
  if (!hasRealFeed()) {
    console.log('[update] no release channel configured; auto-update is off');
    return;
  }

  const au = updater();

  // Download quietly, but never install behind the counter's back.
  au.autoDownload = true;
  au.autoInstallOnAppQuit = true;

  au.on('update-available', (info) => {
    console.log(`[update] ${info.version} available; downloading in the background`);
  });
  au.on('update-downloaded', (info) => {
    console.log(`[update] ${info.version} ready; it will install when the app is closed`);
  });
  au.on('error', (err) => {
    // An unreachable feed is normal for an offline-first shop: log and move on
    // rather than surfacing a dialog nobody at the counter can act on.
    console.error('[update] check failed', err instanceof Error ? err.message : err);
  });

  void au.checkForUpdates();
}
