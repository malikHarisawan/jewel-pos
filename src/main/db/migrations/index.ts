/**
 * Ordered migration registry. Each migration is applied inside a transaction;
 * `user_version` records the highest applied migration so re-runs are no-ops.
 *
 * SQL is inlined via Vite's `?raw` import so it survives bundling/asar packaging
 * (no runtime file reads from the app bundle). Tests run under Vite's transform,
 * so `?raw` resolves there too.
 */
import sql0001 from './0001_init.sql?raw';
import sql0002 from './0002_sale_adjustment.sql?raw';
import sql0003 from './0003_karigar.sql?raw';
import sql0004 from './0004_license.sql?raw';
import sql0005 from './0005_discount_limits.sql?raw';
import sql0006 from './0006_must_change_pin.sql?raw';
import sql0007 from './0007_returns.sql?raw';
import sql0008 from './0008_audit_return_action.sql?raw';
import sql0009 from './0009_party_ledger.sql?raw';
import sql0010 from './0010_tray_startup.sql?raw';
import sql0011 from './0011_walkin_customer_name.sql?raw';

export interface Migration {
  version: number;
  name: string;
  sql: string;
}

export const MIGRATIONS: Migration[] = [
  { version: 1, name: '0001_init', sql: sql0001 },
  { version: 2, name: '0002_sale_adjustment', sql: sql0002 },
  { version: 3, name: '0003_karigar', sql: sql0003 },
  { version: 4, name: '0004_license', sql: sql0004 },
  { version: 5, name: '0005_discount_limits', sql: sql0005 },
  { version: 6, name: '0006_must_change_pin', sql: sql0006 },
  { version: 7, name: '0007_returns', sql: sql0007 },
  { version: 8, name: '0008_audit_return_action', sql: sql0008 },
  { version: 9, name: '0009_party_ledger', sql: sql0009 },
  { version: 10, name: '0010_tray_startup', sql: sql0010 },
  { version: 11, name: '0011_walkin_customer_name', sql: sql0011 },
];

export const LATEST_VERSION = MIGRATIONS[MIGRATIONS.length - 1].version;
