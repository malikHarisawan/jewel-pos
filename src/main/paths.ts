/** App data locations. Kept separate so services can be unit-tested without
 * pulling in Electron's `app`. */
import { app } from 'electron';
import { join } from 'node:path';

export function dataDir(): string {
  return join(app.getPath('userData'), 'data');
}
export function dbPath(): string {
  return join(dataDir(), 'shop.db');
}
export function backupsDir(): string {
  return join(app.getPath('userData'), 'backups');
}
export function photosDir(): string {
  return join(dataDir(), 'photos');
}
