/** Typed API client derived from the contract. Same `Api` type the future LAN
 * HTTP client will implement — only this file's transport (IPC vs fetch) changes. */
import type { Api, Channel } from '../../../shared/contracts/index.js';

interface IpcReply {
  ok: boolean;
  data?: unknown;
  error?: { code: string; message: string };
}

interface PreloadApi {
  invoke(channel: string, payload: unknown): Promise<IpcReply>;
}

declare global {
  interface Window {
    api: PreloadApi;
  }
}

export class ApiCallError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ApiCallError';
  }
}

async function call(channel: Channel, input: unknown): Promise<unknown> {
  const reply = await window.api.invoke(channel, input);
  if (!reply.ok) {
    throw new ApiCallError(reply.error?.code ?? 'INTERNAL', reply.error?.message ?? 'unknown error');
  }
  return reply.data;
}

/** Fully-typed proxy: `api['auth.login']({ username, secret })`. */
export const api = new Proxy({} as Api, {
  get(_t, channel: string) {
    return (input: unknown) => call(channel as Channel, input);
  },
});
