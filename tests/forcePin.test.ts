/**
 * Forced PIN change. A fresh install seeds `owner`/`1234` and prints it to the
 * boot log, so the default must not survive first contact. These tests pin the
 * flag's whole lifecycle: set on seed, set on admin reset, cleared only by the
 * user choosing their own.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { openDatabase, type DB } from '../src/main/db/connection.js';
import { AuthService, ensureFirstOwner } from '../src/main/auth/authService.js';

let db: DB;
let auth: AuthService;

beforeEach(() => {
  db = openDatabase({ filename: ':memory:' });
  auth = new AuthService(db);
});

function flagOf(userId: number): number {
  return (db.prepare('SELECT must_change_pin FROM users WHERE id=?').get(userId) as {
    must_change_pin: number;
  }).must_change_pin;
}

describe('the seeded owner cannot keep the default PIN', () => {
  it('flags the seeded owner so the app blocks on first sign-in', async () => {
    expect(await ensureFirstOwner(db, auth)).toBe(true);
    const session = await auth.login('owner', '1234');
    expect(session.mustChangePin).toBe(true);
  });

  it('clears the flag once the owner picks their own PIN', async () => {
    await ensureFirstOwner(db, auth);
    const session = await auth.login('owner', '1234');
    await auth.changeOwnPin(session.userId, '1234', '8321');

    // The LIVE session must update too — otherwise the gate would still be up
    // and the user would be stuck behind a form they already completed.
    expect(auth.current()?.mustChangePin).toBe(false);
    expect(flagOf(session.userId)).toBe(0);

    // And the new PIN is the one that works from here on.
    auth.logout();
    await expect(auth.login('owner', '1234')).rejects.toThrow(/invalid credentials/);
    expect((await auth.login('owner', '8321')).mustChangePin).toBe(false);
  });

  it('refuses a "change" that re-sets the same PIN', async () => {
    await ensureFirstOwner(db, auth);
    const session = await auth.login('owner', '1234');
    await expect(auth.changeOwnPin(session.userId, '1234', '1234')).rejects.toThrow(
      /must be different/,
    );
    // The flag must survive a rejected change, or the wall would open for free.
    expect(flagOf(session.userId)).toBe(1);
  });

  it('still requires the current PIN to be correct', async () => {
    await ensureFirstOwner(db, auth);
    const session = await auth.login('owner', '1234');
    await expect(auth.changeOwnPin(session.userId, '9999', '5555')).rejects.toThrow(
      /current PIN is incorrect/,
    );
    expect(flagOf(session.userId)).toBe(1);
  });
});

describe('handed-out PINs are always temporary', () => {
  it('flags a newly created user', async () => {
    await ensureFirstOwner(db, auth);
    const id = await auth.createUser(1, {
      username: 'sales',
      displayName: 'Counter',
      secret: '1111',
      role: 'SALESMAN',
    });
    expect(flagOf(id)).toBe(1);
    expect((await auth.login('sales', '1111')).mustChangePin).toBe(true);
  });

  it('re-flags an account after an owner resets its PIN', async () => {
    await ensureFirstOwner(db, auth);
    const id = await auth.createUser(1, {
      username: 'sales',
      displayName: 'Counter',
      secret: '1111',
      role: 'SALESMAN',
    });
    // The user settles on their own PIN...
    await auth.login('sales', '1111');
    await auth.changeOwnPin(id, '1111', '2222');
    expect(flagOf(id)).toBe(0);

    // ...then forgets it and the owner resets. The owner now knows the PIN, so
    // it must be temporary again.
    await auth.resetPin(1, id, '3333');
    expect(flagOf(id)).toBe(1);
    expect((await auth.login('sales', '3333')).mustChangePin).toBe(true);
  });
});

describe('existing installs are not disturbed', () => {
  it('leaves users predating the migration unflagged', async () => {
    // Simulate a row written before 0006 added the column: the DEFAULT 0 applies.
    db.prepare(
      `INSERT INTO users (id, username, display_name, pin_hash, role)
       VALUES (7,'legacy','Legacy','x','MANAGER')`,
    ).run();
    expect(flagOf(7)).toBe(0);
  });
});
