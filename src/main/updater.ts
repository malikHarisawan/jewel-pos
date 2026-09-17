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

/** Placeholder hosts that mean "no feed", whatever the config says. */
const PLACEHOLDER_HOSTS = ['example.com', 'localhost'];

/**
 * Whether `feed` is somewhere real updates could come from.
 *
 * Exported for tests: this one predicate decides whether a shop ever receives
 * an update, and getting it wrong is silent in both directions — a false
 * negative means nobody is ever updated, a false positive means every offline
 * counter logs a failed request on each boot.
 *
 * Plain HTTP is rejected along with the placeholders. An installer fetched
 * over a connection anyone can tamper with is worse than no update at all,
 * and electron-updater would otherwise happily use it.
 */
export function isRealFeed(feed: string | null | undefined): boolean {
  if (!feed) return false;
  try {
    const url = new URL(feed);
    if (url.protocol !== 'https:') return false;
    return !PLACEHOLDER_HOSTS.includes(url.hostname);
  } catch {
    // An unparseable feed is nothing to talk to.
    return false;
  }
}

function hasRealFeed(): boolean {
  try {
    return isRealFeed(updater().getFeedURL());
  } catch {
    // getFeedURL throws when no publish config was compiled in at all.
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
