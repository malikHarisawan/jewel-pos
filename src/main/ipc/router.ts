/**
 * Contract-first router. Maps each contract channel to a handler that receives
 * the main-process session context (never trusting the renderer for identity or
 * role). Input is zod-validated, the caller's role is checked against the
 * endpoint's allow-list, and the handler's result is validated against the
 * endpoint's output schema — that output parse is also where role-based
 * redaction happens, so data a role shouldn't see never crosses the boundary.
 */
import { contract, type Channel, type Contract, type EndpointDef } from '../../shared/contracts/index.js';
import type { z } from 'zod';
import type { DB } from '../db/connection.js';
import type { AuthService, Session } from '../auth/authService.js';
import type { LicenseService } from '../license/licenseService.js';

/**
 * Everything a handler may touch. Deliberately platform-neutral: no Electron
 * type appears here, so the same handlers run behind the LAN HTTP server the
 * architecture is aimed at (and behind the smoke harness today).
 */
export interface AppContext {
  db: DB;
  auth: AuthService;
  license: LicenseService;
  session: Session | null;
  /**
   * Host-supplied file locations and lifecycle. Absent when the host has no
   * concept of them (the HTTP harness), in which case backup endpoints report
   * that they are unavailable rather than crashing.
   */
  platform?: {
    backupsDir: string;
    /** Where full-database CSV dumps are written. Separate from backups: these
     * are readable snapshots and must never appear in the restore list. */
    exportsDir: string;
    dbPath: string;
    /** Restart the app. Used after a restore swaps the database file. */
    relaunch: () => void;
    /**
     * Open a folder inside `exportsDir` in the OS file manager. A CSV dump the
     * shopkeeper cannot find is a dump that was never taken, so the export
     * endpoint reveals its output rather than printing a path they would have
     * to retype. Optional: headless hosts simply omit it.
     */
    revealExport?: (folder: string) => void;
    /**
     * Ask the user where to keep a receipt PDF and write it there. Returns the
     * path written, or null if they cancelled — cancelling a save dialog is a
     * normal outcome and must not surface as an error.
     *
     * Rendering is the host's job because only it owns a window that can be
     * printed; the handler supplies the invoice number for the filename and
     * nothing else. Optional: headless hosts simply omit it.
     */
    saveReceiptPdf?: (invoiceId: number, suggestedName: string) => Promise<string | null>;
    /**
     * Ask the user for a spreadsheet to import and return its absolute path,
     * or null if they cancelled. The dialog lives here rather than in the
     * handler because only the host owns a window to parent it to — and
     * because routing every import through a real dialog is what lets the
     * handler refuse paths the renderer invented. Optional: headless hosts
     * simply omit it.
     */
    pickImportFile?: () => Promise<string | null>;
    /**
     * Push preferences that have an OS-level effect (tray behaviour, the
     * Windows login item) out to the host after Settings writes them.
     * Optional: hosts without a desktop shell simply do not supply it.
     */
    applyDesktopPrefs?: (prefs: {
      closeToTray: boolean;
      launchAtStartup: boolean;
      shopName: string;
    }) => void;
  };
}

type Handler<K extends Channel> = (
  ctx: AppContext,
  input: z.infer<Contract[K]['input']>,
) => Promise<z.infer<Contract[K]['output']>> | z.infer<Contract[K]['output']>;

export type Handlers = { [K in Channel]: Handler<K> };

export class ApiError extends Error {
  constructor(
    public code: 'UNAUTHENTICATED' | 'FORBIDDEN' | 'BAD_INPUT' | 'INTERNAL',
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export function createRouter(handlers: Handlers, getContext: () => AppContext) {
  return async function dispatch(channel: string, rawInput: unknown): Promise<unknown> {
    if (!(channel in contract)) {
      throw new ApiError('BAD_INPUT', `unknown channel: ${channel}`);
    }
    const key = channel as Channel;
    // The contract's `as const satisfies` narrows each entry to only its literal
    // keys; widen to EndpointDef so optional `public`/`roles` are accessible.
    const def = contract[key] as EndpointDef;
    const ctx = getContext();

    if (!def.public && !ctx.session) {
      throw new ApiError('UNAUTHENTICATED', 'authentication required');
    }
    if (def.roles && def.roles.length > 0) {
      if (!ctx.session || !def.roles.includes(ctx.session.role)) {
        throw new ApiError('FORBIDDEN', 'insufficient role');
      }
    }

    const parsedInput = def.input.safeParse(rawInput);
    if (!parsedInput.success) {
      throw new ApiError('BAD_INPUT', parsedInput.error.message);
    }

    // Dynamic dispatch: input was validated against this channel's schema, so
    // the widened `unknown` is safe to pass to the channel's handler.
    const handler = handlers[key] as (ctx: AppContext, input: unknown) => Promise<unknown>;
    const result = await handler(ctx, parsedInput.data);

    const parsedOutput = def.output.safeParse(result);
    if (!parsedOutput.success) {
      throw new ApiError('INTERNAL', `output validation failed: ${parsedOutput.error.message}`);
    }
    return parsedOutput.data;
  };
}
