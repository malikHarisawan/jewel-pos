/** App settings — a small typed view over the app_settings key/value table.
 * Only whitelisted keys are readable/writable so the UI can't set arbitrary keys. */
import type { DB } from '../db/connection.js';
import { withAudit } from '../db/audit.js';

/** Keys the Settings screen manages, with their defaults. */
const SETTING_DEFAULTS = {
  shop_name: 'My Jewellers',
  shop_address: '',
  shop_phone: '',
  tax_rate_bp: '300',
  tax_base: 'TOTAL_MINUS_METAL',
  invoice_round_to: '100',
  tola_mg: '11664',
  idle_lock_minutes: '10',
  max_discount_pct_salesman: '5',
  max_discount_pct_manager: '20',
  // Closing the window parks the till in the tray rather than shutting it down.
  close_to_tray: '1',
  // Off by default: software must never add itself to a machine's startup
  // without being asked. The shop turns this on from Settings.
  launch_at_startup: '0',
} as const;

export type SettingKey = keyof typeof SETTING_DEFAULTS;
const KEYS = Object.keys(SETTING_DEFAULTS) as SettingKey[];

export function getSettings(db: DB): Record<SettingKey, string> {
  const out = { ...SETTING_DEFAULTS } as Record<SettingKey, string>;
  const rows = db.prepare('SELECT key, value FROM app_settings').all() as Array<{
    key: string;
    value: string;
  }>;
  for (const r of rows) {
    if ((KEYS as string[]).includes(r.key)) out[r.key as SettingKey] = r.value;
  }
  return out;
}

export function updateSettings(
  db: DB,
  userId: number,
  patch: Partial<Record<SettingKey, string>>,
): Record<SettingKey, string> {
  return withAudit(db, userId, (ctx) => {
    const upsert = db.prepare(
      `INSERT INTO app_settings (key, value, updated_by) VALUES (@key, @value, @user)
       ON CONFLICT(key) DO UPDATE SET value=@value,
         updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'), updated_by=@user`,
    );
    const changed: Record<string, string> = {};
    for (const [key, value] of Object.entries(patch)) {
      if (!(KEYS as string[]).includes(key) || value == null) continue;
      upsert.run({ key, value, user: userId });
      changed[key] = value;
    }
    ctx.record({ table: 'app_settings', rowPk: 0, action: 'UPDATE', changes: changed });
    return getSettings(db);
  });
}
