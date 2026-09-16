/**
 * First-run setup.
 *
 * A new install already knows how a Pakistani jewellery shop usually works —
 * FBR's gold-exempt tax base, rounding to the rupee, an 11.664g tola, the four
 * common gold purities. Asking the owner to decide all of that before they can
 * ring up a single sale is what makes the app feel heavy on day one.
 *
 * So the wizard asks only the four things that genuinely differ per shop, and
 * everything else arrives already correct and editable in Settings.
 *
 * Deactivating unused purities matters more than it looks: every inactive
 * purity is one more row the owner must post a rate for each morning before the
 * app will price anything.
 */
import type { DB } from '../db/connection.js';
import { withAudit } from '../db/audit.js';
import { updateSettings } from './settingsService.js';

export interface SetupInput {
  shopName: string;
  shopPhone: string;
  shopAddress: string;
  /** false sets the tax rate to zero; the FBR-correct base is kept either way. */
  chargesTax: boolean;
  taxRateBp: number;
  /** Purity ids the shop actually deals in. Others are deactivated. */
  activePurityIds: number[];
}

export interface SetupStatus {
  completed: boolean;
  /** Steps still outstanding, in the order the owner should do them. */
  remaining: Array<'SHOP_DETAILS' | 'PURITIES' | 'RATE' | 'STOCK'>;
}

/**
 * What still stands between this shop and its first sale.
 *
 * Derived from the data rather than from a checkbox, so it stays honest if the
 * owner deletes something later — and so the dashboard can nudge them toward
 * the exact next thing instead of a generic "finish setup".
 */
export function setupStatus(db: DB): SetupStatus {
  const setting = (k: string) =>
    (db.prepare('SELECT value FROM app_settings WHERE key=?').get(k) as
      | { value: string }
      | undefined)?.value ?? '';

  const remaining: SetupStatus['remaining'] = [];

  if (!setting('shop_name') || setting('shop_name') === 'My Jewellers') {
    remaining.push('SHOP_DETAILS');
  }

  /* A shop that has already been used is not a fresh install, whatever the
     settings still say. Someone who imported stock and posted rates before
     getting round to the shop name must not be interrupted by a first-run
     wizard — they are already working, and the name is one field in Settings.
     This is checked against real activity rather than a flag so it stays true
     for shops that upgraded into this version with data already in place. */
  const hasTraded =
    (db.prepare('SELECT COUNT(*) AS n FROM documents').get() as { n: number }).n > 0 ||
    (db.prepare('SELECT COUNT(*) AS n FROM items').get() as { n: number }).n > 0;

  const activePurities = (
    db.prepare('SELECT COUNT(*) AS n FROM purities WHERE is_active = 1').get() as { n: number }
  ).n;
  if (activePurities === 0) remaining.push('PURITIES');

  const ratedPurities = (
    db.prepare(
      `SELECT COUNT(DISTINCT purity_id) AS n FROM metal_rates
       WHERE purity_id IN (SELECT id FROM purities WHERE is_active = 1)`,
    ).get() as { n: number }
  ).n;
  if (ratedPurities === 0) remaining.push('RATE');

  const items = (db.prepare('SELECT COUNT(*) AS n FROM items').get() as { n: number }).n;
  if (items === 0) remaining.push('STOCK');

  return {
    // An already-working shop counts as set up: the wizard's job is to get a
    // blank install to its first sale, and this one is long past that.
    completed: setting('setup_completed') === '1' || hasTraded,
    remaining,
  };
}

/**
 * Apply the wizard's answers.
 *
 * One transaction: a half-applied setup would leave the shop in a state the
 * wizard would not offer to fix, since it marks itself done at the end.
 */
export function applySetup(db: DB, userId: number, input: SetupInput) {
  return withAudit(db, userId, (ctx) => {
    const run = db.transaction(() => {
      if (input.activePurityIds.length > 0) {
        const ids = input.activePurityIds.join(',');
        // Only gold purities are narrowed. Silver and platinum are left as the
        // shop found them: a jeweller who does not deal in them simply never
        // posts a rate, and an unrated purity already stays out of the way.
        db.prepare(
          `UPDATE purities SET is_active = 0
           WHERE id NOT IN (${ids})
             AND metal_id = (SELECT id FROM metals WHERE name = 'Gold')`,
        ).run();
        db.prepare(`UPDATE purities SET is_active = 1 WHERE id IN (${ids})`).run();
      }

      updateSettings(db, userId, {
        shop_name: input.shopName,
        shop_phone: input.shopPhone,
        shop_address: input.shopAddress,
        tax_rate_bp: String(input.chargesTax ? input.taxRateBp : 0),
        setup_completed: '1',
      });
    });
    run();

    ctx.record({
      table: 'app_settings',
      rowPk: 0,
      action: 'UPDATE',
      changes: { setup: 'completed', shopName: input.shopName },
    });

    return setupStatus(db);
  });
}
