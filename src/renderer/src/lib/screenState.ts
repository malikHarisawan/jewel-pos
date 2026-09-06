/**
 * Screen state that survives navigation.
 *
 * Routes unmount when you leave them, so every `useState` on a screen resets:
 * a half-filled item form, a POS cart mid-sale, a search box. This keeps that
 * state in a module-level map — outside React, so an unmount cannot clear it —
 * and hands it back when the screen mounts again.
 *
 * Deliberately memory-only. Nothing is written to disk, so closing the app is
 * still a clean slate and no draft can outlive the session that typed it.
 * Cleared wholesale on sign-out, so one user's work never reaches the next.
 */

const store = new Map<string, unknown>();

export function readScreenState<T>(key: string): T | undefined {
  return store.get(key) as T | undefined;
}

export function writeScreenState(key: string, value: unknown): void {
  store.set(key, value);
}

export function clearScreenState(key: string): void {
  store.delete(key);
}

/** Drop everything. Called on sign-out and on the idle lock — the next person
 * at the counter must not inherit the last one's cart or half-typed item. */
export function clearAllScreenState(): void {
  store.clear();
}
