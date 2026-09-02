/** Binds the router to Electron IPC — the only Electron-coupled part of the API
 * layer. A future LAN server would replace just this file with an HTTP adapter
 * over the same router. */
import { ipcMain } from 'electron';
import { createRouter, ApiError, type AppContext } from './router.js';
import { handlers } from './handlers.js';

export const IPC_CHANNEL = 'api:invoke';

export interface IpcReply {
  ok: boolean;
  data?: unknown;
  error?: { code: string; message: string };
}

export function registerIpc(getContext: () => AppContext): void {
  const dispatch = createRouter(handlers, getContext);

  ipcMain.handle(
    IPC_CHANNEL,
    async (_event, channel: string, input: unknown): Promise<IpcReply> => {
      try {
        const data = await dispatch(channel, input);
        return { ok: true, data };
      } catch (err) {
        const code = err instanceof ApiError ? err.code : 'INTERNAL';
        const message = err instanceof Error ? err.message : String(err);
        return { ok: false, error: { code, message } };
      }
    },
  );
}
