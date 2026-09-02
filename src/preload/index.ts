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

contextBridge.exposeInMainWorld('api', api);

export type PreloadApi = typeof api;
