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

export interface AppContext {
  db: DB;
  auth: AuthService;
  license: LicenseService;
  session: Session | null;
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
