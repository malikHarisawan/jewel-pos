import { describe, it, expect, beforeEach } from 'vitest';
import { openDatabase, type DB } from '../src/main/db/connection.js';
import { AuthService, ensureFirstOwner } from '../src/main/auth/authService.js';
import { getSettings, updateSettings } from '../src/main/services/settingsService.js';

let db: DB;
let auth: AuthService;

beforeEach(async () => {
  db = openDatabase({ filename: ':memory:' });
  auth = new AuthService(db);
  await ensureFirstOwner(db, auth); // seeds owner id 1
});

describe('settings', () => {
  it('returns defaults then persists updates', () => {
    const before = getSettings(db);
    expect(before.shop_name).toBe('My Jewellers'); // seeded default
    const after = updateSettings(db, 1, { shop_name: 'Al-Karim Jewellers', tax_rate_bp: '150' });
    expect(after.shop_name).toBe('Al-Karim Jewellers');
    expect(after.tax_rate_bp).toBe('150');
    // re-read persists
    expect(getSettings(db).shop_name).toBe('Al-Karim Jewellers');
  });

  it('ignores unknown keys', () => {
    updateSettings(db, 1, { ['evil' as never]: 'x' as never });
    const s = getSettings(db) as Record<string, string>;
    expect(s['evil']).toBeUndefined();
  });
});

describe('user management', () => {
  it('lists the seeded owner', () => {
    const users = auth.listUsers();
    expect(users).toHaveLength(1);
    expect(users[0].role).toBe('OWNER');
    expect(users[0].isActive).toBe(true);
  });

  it('creates a salesman and can log in as them', async () => {
    await auth.createUser(1, {
      username: 'sana',
      displayName: 'Sana',
      secret: '4321',
      role: 'SALESMAN',
    });
    const users = auth.listUsers();
    expect(users).toHaveLength(2);
    const s = await auth.login('sana', '4321');
    expect(s.role).toBe('SALESMAN');
  });

  it('deactivates a user and blocks their login', async () => {
    const id = await auth.createUser(1, {
      username: 'sana',
      displayName: 'Sana',
      secret: '4321',
      role: 'SALESMAN',
    });
    auth.setUserActive(1, id, false);
    expect(auth.listUsers().find((u) => u.id === id)!.isActive).toBe(false);
    await expect(auth.login('sana', '4321')).rejects.toThrow(/invalid credentials/);
  });

  it('refuses to disable the last active owner', () => {
    expect(() => auth.setUserActive(1, 1, false)).toThrow(/last active owner/);
  });

  it('resets a PIN (owner) and the user can log in with the new one', async () => {
    const id = await auth.createUser(1, {
      username: 'sana',
      displayName: 'Sana',
      secret: '4321',
      role: 'SALESMAN',
    });
    await auth.resetPin(1, id, '9999');
    await expect(auth.login('sana', '4321')).rejects.toThrow();
    const s = await auth.login('sana', '9999');
    expect(s.username).toBe('sana');
  });

  it('lets a user change their own PIN with the correct current one', async () => {
    const id = await auth.createUser(1, {
      username: 'sana',
      displayName: 'Sana',
      secret: '4321',
      role: 'SALESMAN',
    });
    await expect(auth.changeOwnPin(id, 'wrong', '5555')).rejects.toThrow(/incorrect/);
    await auth.changeOwnPin(id, '4321', '5555');
    const s = await auth.login('sana', '5555');
    expect(s.userId).toBe(id);
  });
});
