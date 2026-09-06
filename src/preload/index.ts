/** Preload bridge. Exposes exactly one allow-listed function to the renderer:
 * `api.invoke(channel, payload)`. No Node APIs leak into the renderer. */
import { contextBridge, ipcRenderer } from 'electron';

const IPC_CHANNEL = 'api:invoke';

export interface IpcReply {
  ok: boolean;
  data?: unknown;
  error?: { code: string; message: string };
}

const api = {
  invoke: (channel: string, payload: unknown): Promise<IpcReply> =>
    ipcRenderer.invoke(IPC_CHANNEL, channel, payload),
};

/** Window chrome for the custom title bar. Separate from `api` because these
 * carry no payload and bypass the contract router — they are the frameless
 * window's minimise / maximise / close, nothing more. */
const windowControls = {
  minimize: (): void => ipcRenderer.send('window:minimize'),
  toggleMaximize: (): void => ipcRenderer.send('window:toggle-maximize'),
  close: (): void => ipcRenderer.send('window:close'),
  isMaximized: (): Promise<boolean> =>
    ipcRenderer.invoke('window:is-maximized') as Promise<boolean>,
  /** Returns an unsubscribe function so React effects can clean up. */
  onStateChange: (fn: (s: { maximized: boolean }) => void): (() => void) => {
    const listener = (_e: unknown, s: { maximized: boolean }): void => fn(s);
    ipcRenderer.on('window:state', listener);
    return () => {
      ipcRenderer.off('window:state', listener);
    };
  },
};

contextBridge.exposeInMainWorld('api', api);
contextBridge.exposeInMainWorld('windowControls', windowControls);

export type PreloadApi = typeof api;
export type WindowControls = typeof windowControls;
