/** Renderer-side handle on the frameless window's chrome. The app draws its own
 * title bar, so minimise / maximise / close are ordinary buttons that call
 * through here. Kept out of `api.ts`: these are not contract channels. */

export interface WindowControls {
  minimize(): void;
  toggleMaximize(): void;
  close(): void;
  isMaximized(): Promise<boolean>;
  onStateChange(fn: (s: { maximized: boolean }) => void): () => void;
}

declare global {
  interface Window {
    windowControls?: WindowControls;
  }
}

/* Undefined when the renderer runs outside Electron — the smoke tests load the
   page in a plain browser, where the buttons simply do nothing. */
export const windowControls: WindowControls | undefined =
  typeof window === 'undefined' ? undefined : window.windowControls;
