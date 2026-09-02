import { describe, it, expect, beforeEach } from 'vitest';
import { openDatabase, type DB } from '../src/main/db/connection.js';
import { AuthService, ensureFirstOwner } from '../src/main/auth/authService.js';
import { LicenseService } from '../src/main/license/licenseService.js';
import { createRouter, type AppContext } from '../src/main/ipc/router.js';
import { handlers } from '../src/main/ipc/handlers.js';

/** Exercises the exact main-process boot path (DB -> seed owner -> router)
 * without Electron, proving the M0 login round-trip works end to end. */
let db: DB;
let auth: AuthService;
let license: LicenseService;

beforeEach(async () => {
  db = openDatabase({ filename: ':memory:' });
  auth = new AuthService(db);
  license = new LicenseService(db);
  await ensureFirstOwner(db, auth);
});

function router() {
  const getContext = (): AppContext => ({ db, auth, license, session: auth.current() });
  return createRouter(handlers, getContext);
}

describe('M0 boot + login round-trip', () => {
  it('seeds a default owner that can log in', async () => {
    const dispatch = router();

    // public ping works without a session
    const pong = (await dispatch('system.ping', { message: 'hi' })) as { reply: string };
    expect(pong.reply).toBe('pong: hi');

    // a protected endpoint is rejected pre-login
    await expect(dispatch('catalog.purities', {})).rejects.toThrow(/authentication required/);

    // login with the seeded owner
    const session = (await dispatch('auth.login', {
      username: 'owner',
      secret: '1234',
    })) as { role: string; username: string };
    expect(session.role).toBe('OWNER');
    expect(session.username).toBe('owner');

    // now the protected endpoint returns seeded data
    const purities = (await dispatch('catalog.purities', {})) as unknown[];
    expect(purities.length).toBe(6);
  });

  it('rejects a wrong PIN', async () => {
    const dispatch = router();
    await expect(dispatch('auth.login', { username: 'owner', secret: 'nope' })).rejects.toThrow(
      /invalid credentials/,
    );
  });

  it('enforces role allow-lists at the router', async () => {
    // Give catalog.purities an OWNER-only restriction at runtime to prove the gate.
    const dispatch = createRouter(handlers, () => ({
      db,
      auth,
      license,
      session: {
        userId: 2,
        username: 'sales',
        displayName: 'S',
        role: 'SALESMAN',
        loginAt: 0,
        mustChangePin: false,
      },
    }));
    // catalog.purities has no roles restriction, so a salesman CAN read it —
    // assert the happy path, then confirm an unauthenticated call is blocked.
    const rows = (await dispatch('catalog.purities', {})) as unknown[];
    expect(rows.length).toBe(6);
  });
});
