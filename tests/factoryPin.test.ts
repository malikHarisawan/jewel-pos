/**
 * The sign-in screen prints the factory credentials so a new shop can get in.
 * Once the owner picks their own PIN that hint names a PIN that no longer
 * works, which reads as a broken app — so it has to disappear. These tests pin
 * when it shows and, more importantly, when it must not.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { openDatabase, type DB } from '../src/main/db/connection.js';
import { AuthService, ensureFirstOwner, factoryPinStatus } from '../src/main/auth/authService.js';

let db: DB;
let auth: AuthService;

beforeEach(async () => {
  db = openDatabase({ filename: ':memory:' });
  auth = new AuthService(db);
  await ensureFirstOwner(db, auth);
});

describe('factory PIN hint', () => {
  it('shows on a fresh install', () => {
    const s = factoryPinStatus(db);
    expect(s.anyDefaultPin).toBe(true);
    expect(s.username).toBe('owner');
  });

  it('disappears once the owner chooses their own PIN', async () => {
    const session = await auth.login('owner', '1234');
    expect(session.mustChangePin).toBe(true);
    await auth.changeOwnPin(session.userId, '1234', '907182');
    // The published credentials no longer open the shop, so the hint must go.
    expect(factoryPinStatus(db).anyDefaultPin).toBe(false);
  });

  it('stays hidden after the owner signs out and back in', async () => {
    const session = await auth.login('owner', '1234');
    await auth.changeOwnPin(session.userId, '1234', '907182');
    auth.logout();
    await auth.login('owner', '907182');
    expect(factoryPinStatus(db).anyDefaultPin).toBe(false);
  });

  it('ignores a staff member who was issued a PIN by the owner', async () => {
    const session = await auth.login('owner', '1234');
    await auth.changeOwnPin(session.userId, '1234', '907182');
    // A salesman also carries must_change_pin=1, but their PIN was never
    // published, so they are none of this hint's business.
    await auth.createUser(session.userId, {
      username: 'salesman',
      displayName: 'Counter Staff',
      secret: '5566',
      role: 'SALESMAN',
    });
    expect(factoryPinStatus(db).anyDefaultPin).toBe(false);
  });

  it('does not resurface if the owner account is deactivated', async () => {
    // An owner who never changed the PIN but is switched off cannot sign in,
    // so advertising the credentials would be pure noise.
    db.prepare(`UPDATE users SET is_active = 0 WHERE username = 'owner'`).run();
    expect(factoryPinStatus(db).anyDefaultPin).toBe(false);
  });

  it('reports nothing on a database with no users at all', () => {
    db.prepare(`DELETE FROM users`).run();
    const s = factoryPinStatus(db);
    expect(s.anyDefaultPin).toBe(false);
    expect(s.username).toBeNull();
  });
});
