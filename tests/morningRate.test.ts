import { describe, it, expect, beforeEach } from 'vitest';
import { openDatabase, type DB } from '../src/main/db/connection.js';
import {
  enterRate,
  latestRates,
  morningBoard,
  postRates,
  previewDerivedRates,
} from '../src/main/services/rateService.js';
import { deriveRateByFineness, rateDeltaBp } from '../src/shared/units/index.js';

let db: DB;

function purity(d: DB, label: string) {
  return (d.prepare('SELECT id FROM purities WHERE label=?').get(label) as { id: number }).id;
}

beforeEach(() => {
  db = openDatabase({ filename: ':memory:' });
  db.prepare(
    `INSERT INTO users (id, username, display_name, pin_hash, role) VALUES (1,'owner','Owner','x','OWNER')`,
  ).run();
});

describe('deriveRateByFineness', () => {
  it('scales a 24K rate down to 22K by fineness ratio', () => {
    // Rs 25,000/g at 999 -> 916 is 25,000 * 916/999
    expect(deriveRateByFineness(2_500_000, 999, 916)).toBe(2_292_292);
  });

  it('is identity when the fineness is unchanged', () => {
    expect(deriveRateByFineness(2_500_000, 916, 916)).toBe(2_500_000);
  });

  it('rounds half up once, never truncating toward zero', () => {
    // 3 * 2 / 4 = 1.5 -> 2
    expect(deriveRateByFineness(3, 4, 2)).toBe(2);
  });

  it('refuses a non-positive fineness rather than dividing by zero', () => {
    expect(() => deriveRateByFineness(2_500_000, 0, 916)).toThrow(/fineness/);
    expect(() => deriveRateByFineness(2_500_000, 999, 0)).toThrow(/fineness/);
  });
});

describe('rateDeltaBp', () => {
  it('reports no movement when there is no previous rate', () => {
    expect(rateDeltaBp(null, 2_500_000)).toBe(0);
  });

  it('measures a rise as basis points of the previous rate', () => {
    // 2,500,000 -> 2,625,000 is +5%
    expect(rateDeltaBp(2_500_000, 2_625_000)).toBe(500);
  });

  it('measures a fall with the same magnitude as a rise', () => {
    expect(rateDeltaBp(2_500_000, 2_375_000)).toBe(500);
  });

  it('flags a fat-fingered extra zero as an enormous jump', () => {
    // The whole point of the warning: 10x is 900%.
    expect(rateDeltaBp(2_500_000, 25_000_000)).toBe(90_000);
  });
});

describe('morningBoard', () => {
  it('marks every purity stale when nothing has ever been posted', () => {
    const board = morningBoard(db);
    expect(board.needsPosting).toBe(true);
    expect(board.purities.every((p) => p.isStale)).toBe(true);
    expect(board.purities.every((p) => p.lastRatePaisaPerGram === null)).toBe(true);
  });

  it('anchors derivation on the highest-fineness gold purity', () => {
    const board = morningBoard(db);
    expect(board.basisPurityId).toBe(purity(db, '24K / 999'));
  });

  it('clears staleness for a purity posted today', () => {
    const p24 = purity(db, '24K / 999');
    enterRate(db, 1, { purityId: p24, enteredValuePaisa: 2_500_000, enteredBasis: 'PER_GRAM' });

    const board = morningBoard(db);
    const posted = board.purities.find((p) => p.purityId === p24)!;
    expect(posted.isStale).toBe(false);
    expect(posted.lastRatePaisaPerGram).toBe(2_500_000);

    // 22K has never been priced, so this shop does not deal in it and must not
    // be nagged for it. Only a purity the shop has actually traded can be due.
    const p22 = board.purities.find((p) => p.label === '22K / 916')!;
    expect(p22.lastRatePaisaPerGram).toBeNull();
    expect(board.needsPosting).toBe(false);
  });

  it('asks again the next day for a purity the shop does trade', () => {
    const p22 = purity(db, '22K / 916');
    // Traded yesterday, nothing posted today -> genuinely due.
    db.prepare(
      `INSERT INTO metal_rates
         (purity_id, rate_paisa_per_gram, entered_value_paisa, entered_basis, entered_by, effective_at)
       VALUES (?,?,?,'PER_GRAM',1, datetime('now','-1 day'))`,
    ).run(p22, 2_292_292, 2_292_292);

    expect(morningBoard(db).needsPosting).toBe(true);
  });

  it('treats a rate posted on an earlier day as stale', () => {
    const p24 = purity(db, '24K / 999');
    // metal_rates is append-only even to a test, so "yesterday's rate" is
    // inserted with a past timestamp rather than aged after the fact.
    db.prepare(
      `INSERT INTO metal_rates
         (purity_id, rate_paisa_per_gram, entered_value_paisa, entered_basis, entered_by, effective_at)
       VALUES (?,?,?,'PER_GRAM',1, datetime('now','-2 days'))`,
    ).run(p24, 2_500_000, 2_500_000);

    const board = morningBoard(db);
    expect(board.purities.find((p) => p.purityId === p24)!.isStale).toBe(true);
    expect(board.needsPosting).toBe(true);
  });

  it('ignores deactivated purities so they never demand a morning rate', () => {
    const p18 = purity(db, '18K / 750');
    db.prepare('UPDATE purities SET is_active = 0 WHERE id = ?').run(p18);
    const board = morningBoard(db);
    expect(board.purities.some((p) => p.purityId === p18)).toBe(false);
  });
});

describe('previewDerivedRates', () => {
  it('derives every gold purity from a 24K post without writing anything', () => {
    const p24 = purity(db, '24K / 999');
    const preview = previewDerivedRates(db, p24, 2_500_000, 'PER_GRAM');

    const basis = preview.find((r) => r.isBasis)!;
    expect(basis.ratePaisaPerGram).toBe(2_500_000);

    const k22 = preview.find((r) => r.finenessMillesimal === 916)!;
    expect(k22.ratePaisaPerGram).toBe(deriveRateByFineness(2_500_000, 999, 916));

    // Nothing was posted by previewing.
    expect(latestRates(db).every((r) => r.ratePaisaPerGram === null)).toBe(true);
  });

  it('converts a per-tola entry before deriving', () => {
    const p24 = purity(db, '24K / 999');
    // Rs 291,600/tola is exactly Rs 25,000/g on an 11.664g tola.
    const preview = previewDerivedRates(db, p24, 29_160_000, 'PER_TOLA');
    expect(preview.find((r) => r.isBasis)!.ratePaisaPerGram).toBe(2_500_000);
  });

  it('leaves other metals out — silver does not follow the gold rate', () => {
    const p24 = purity(db, '24K / 999');
    const preview = previewDerivedRates(db, p24, 2_500_000, 'PER_GRAM');
    expect(preview.some((r) => r.label.toLowerCase().includes('silver'))).toBe(false);
  });

  it('reports the jump against what was last posted', () => {
    const p24 = purity(db, '24K / 999');
    enterRate(db, 1, { purityId: p24, enteredValuePaisa: 2_500_000, enteredBasis: 'PER_GRAM' });

    const preview = previewDerivedRates(db, p24, 2_625_000, 'PER_GRAM');
    expect(preview.find((r) => r.isBasis)!.deltaBp).toBe(500);
  });

  it('refuses an unknown purity rather than deriving from nothing', () => {
    expect(() => previewDerivedRates(db, 9999, 2_500_000, 'PER_GRAM')).toThrow(/not found/);
  });
});

describe('postRates', () => {
  it('posts the whole board in one action', () => {
    const p24 = purity(db, '24K / 999');
    const preview = previewDerivedRates(db, p24, 2_500_000, 'PER_GRAM');

    postRates(
      db,
      1,
      preview.map((r) => ({
        purityId: r.purityId,
        enteredValuePaisa: r.ratePaisaPerGram,
        enteredBasis: 'PER_GRAM' as const,
      })),
    );

    const latest = latestRates(db);
    for (const r of preview) {
      expect(latest.find((l) => l.purityId === r.purityId)!.ratePaisaPerGram).toBe(
        r.ratePaisaPerGram,
      );
    }
    // A gold-only shop is now done for the morning: silver and platinum ship
    // active but have never been traded, so they must not nag.
    expect(morningBoard(db).needsPosting).toBe(false);
  });

  it('writes nothing at all when one line in the batch is bad', () => {
    const p24 = purity(db, '24K / 999');
    expect(() =>
      postRates(db, 1, [
        { purityId: p24, enteredValuePaisa: 2_500_000, enteredBasis: 'PER_GRAM' },
        // No such purity — the FK fails and must roll the first line back too.
        { purityId: 9999, enteredValuePaisa: 2_000_000, enteredBasis: 'PER_GRAM' },
      ]),
    ).toThrow();

    // The valid line must not have survived: a half-posted board is exactly
    // the state the morning card exists to prevent.
    expect(latestRates(db).find((r) => r.purityId === p24)!.ratePaisaPerGram).toBeNull();
  });

  it('is a no-op for an empty batch', () => {
    expect(postRates(db, 1, [])).toEqual([]);
  });

  it('leaves derived rates indistinguishable from typed ones in history', () => {
    const p24 = purity(db, '24K / 999');
    const preview = previewDerivedRates(db, p24, 2_500_000, 'PER_GRAM');
    const posted = postRates(
      db,
      1,
      preview.map((r) => ({
        purityId: r.purityId,
        enteredValuePaisa: r.ratePaisaPerGram,
        enteredBasis: 'PER_GRAM' as const,
      })),
    );
    // Each is a real posted rate with an author, not a synthetic marker.
    expect(posted.every((r) => r.enteredByName === 'Owner')).toBe(true);
    expect(posted.every((r) => r.id > 0)).toBe(true);
  });
});
