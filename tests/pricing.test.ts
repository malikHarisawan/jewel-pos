import { describe, it, expect } from 'vitest';
import {
  priceSaleLine,
  priceOldGoldLine,
  totalDocument,
  type PricingItemInput,
  type RateSnapshot,
  type TaxConfig,
} from '../src/shared/pricing/engine.js';

// 22K gold at Rs 25,000/gram = 2,500,000 paisa/gram
const rate22k: RateSnapshot = { purityId: 1, metalRateId: 1, ratePaisaPerGram: 2_500_000 };
const noTax: TaxConfig = { rateBp: 0, base: 'TOTAL' };
const fbrTax: TaxConfig = { rateBp: 300, base: 'TOTAL_MINUS_METAL' };

function plainRing(overrides: Partial<PricingItemInput> = {}): PricingItemInput {
  return {
    netMg: 10_000, // 10 g
    wastageBp: 0,
    making: { mode: 'PER_GRAM', ratePaisa: 50_000 }, // Rs 500/g
    stones: [],
    hallmarkChargePaisa: 0,
    ...overrides,
  };
}

describe('priceSaleLine - metal value', () => {
  it('computes metal value from net weight and rate', () => {
    const b = priceSaleLine(plainRing({ making: { mode: 'FIXED', ratePaisa: 0 } }), rate22k, { paisa: 0 }, noTax);
    // 10 g * Rs 25,000 = Rs 250,000 = 25,000,000 paisa
    expect(b.metalValuePaisa).toBe(25_000_000);
    expect(b.lineTotalPaisa).toBe(25_000_000);
  });
});

describe('making charge modes', () => {
  it('PER_GRAM', () => {
    const b = priceSaleLine(plainRing(), rate22k, { paisa: 0 }, noTax);
    // 10 g * Rs 500/g = Rs 5,000 = 500,000 paisa
    expect(b.makingValuePaisa).toBe(500_000);
  });

  it('FIXED', () => {
    const b = priceSaleLine(
      plainRing({ making: { mode: 'FIXED', ratePaisa: 750_000 } }),
      rate22k,
      { paisa: 0 },
      noTax,
    );
    expect(b.makingValuePaisa).toBe(750_000);
  });

  it('PCT_OF_METAL (bp of metal value)', () => {
    const b = priceSaleLine(
      plainRing({ making: { mode: 'PCT_OF_METAL', ratePaisa: 1200 } }), // 12%
      rate22k,
      { paisa: 0 },
      noTax,
    );
    // 12% of 25,000,000 = 3,000,000
    expect(b.makingValuePaisa).toBe(3_000_000);
  });
});

describe('wastage', () => {
  it('applies wastage as % of metal value', () => {
    const b = priceSaleLine(
      plainRing({ wastageBp: 850, making: { mode: 'FIXED', ratePaisa: 0 } }), // 8.5%
      rate22k,
      { paisa: 0 },
      noTax,
    );
    // 8.5% of 25,000,000 = 2,125,000
    expect(b.wastageValuePaisa).toBe(2_125_000);
  });
});

describe('stones', () => {
  it('sums per-stone value', () => {
    const b = priceSaleLine(
      plainRing({
        making: { mode: 'FIXED', ratePaisa: 0 },
        stones: [
          { totalCaratC: 150, ratePaisaPerCarat: 5_000_000 }, // 1.5 ct @ Rs 50,000/ct = Rs 75,000
          { totalCaratC: 50, ratePaisaPerCarat: 2_000_000 }, // 0.5 ct @ Rs 20,000/ct = Rs 10,000
        ],
      }),
      rate22k,
      { paisa: 0 },
      noTax,
    );
    expect(b.stoneValuePaisa).toBe(7_500_000 + 1_000_000);
  });
});

describe('FBR tax base', () => {
  it('excludes exempt metal value from the taxable base', () => {
    const b = priceSaleLine(plainRing(), rate22k, { paisa: 0 }, fbrTax);
    // taxable base = making 500,000 (metal excluded, no wastage/stone/hallmark)
    expect(b.taxableBasePaisa).toBe(500_000);
    // 3% of 500,000 = 15,000
    expect(b.taxPaisa).toBe(15_000);
    // line total = metal 25,000,000 + making 500,000 + tax 15,000
    expect(b.lineTotalPaisa).toBe(25_515_000);
  });
});

describe('discount', () => {
  it('reduces total and taxable base', () => {
    const b = priceSaleLine(plainRing(), rate22k, { paisa: 100_000 }, noTax);
    expect(b.discountPaisa).toBe(100_000);
    expect(b.lineTotalPaisa).toBe(25_000_000 + 500_000 - 100_000);
  });
});

describe('old gold exchange', () => {
  it('is a negative pure-metal credit by touch', () => {
    // 20 g old gold at 91.6% touch, valued at 22K rate
    const b = priceOldGoldLine(20_000, 9160, rate22k);
    // 20 g * 0.916 * Rs 25,000 = Rs 458,000 = 45,800,000 paisa, negative
    expect(b.lineTotalPaisa).toBe(-45_800_000);
    expect(b.metalValuePaisa).toBe(-45_800_000);
    expect(b.taxPaisa).toBe(0);
  });
});

describe('document totals reconcile', () => {
  it('subtotal + rounding === grandTotal, rounded to nearest rupee', () => {
    const sale = priceSaleLine(plainRing({ netMg: 8_333 }), rate22k, { paisa: 137 }, fbrTax);
    const oldGold = priceOldGoldLine(3_333, 9160, rate22k);
    const totals = totalDocument([sale, oldGold], 100);

    expect(totals.subtotalPaisa).toBe(sale.lineTotalPaisa + oldGold.lineTotalPaisa);
    expect(totals.subtotalPaisa + totals.roundingPaisa).toBe(totals.grandTotalPaisa);
    // grand total is a whole number of rupees
    expect(totals.grandTotalPaisa % 100).toBe(0);
    // rounding is within half a rupee
    expect(Math.abs(totals.roundingPaisa)).toBeLessThanOrEqual(50);
  });

  it('component subtotals equal the sum of line components', () => {
    const a = priceSaleLine(plainRing(), rate22k, { paisa: 0 }, fbrTax);
    const b = priceSaleLine(plainRing({ netMg: 5_000 }), rate22k, { paisa: 0 }, fbrTax);
    const totals = totalDocument([a, b], 1);
    expect(totals.metalValuePaisa).toBe(a.metalValuePaisa + b.metalValuePaisa);
    expect(totals.makingValuePaisa).toBe(a.makingValuePaisa + b.makingValuePaisa);
    expect(totals.taxPaisa).toBe(a.taxPaisa + b.taxPaisa);
    // no rounding when roundTo=1
    expect(totals.roundingPaisa).toBe(0);
  });
});
