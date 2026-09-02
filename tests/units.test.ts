import { describe, it, expect } from 'vitest';
import {
  roundHalfUp,
  gramsToMg,
  mgToTola,
  formatWeight,
  rupeesToPaisa,
  formatPKR,
  normalizeRateToPaisaPerGram,
  TOLA_MG,
} from '../src/shared/units/index.js';

describe('roundHalfUp', () => {
  it('rounds half up', () => {
    expect(roundHalfUp(5, 2)).toBe(3); // 2.5 -> 3
    expect(roundHalfUp(4, 2)).toBe(2);
    expect(roundHalfUp(3, 2)).toBe(2); // 1.5 -> 2
    expect(roundHalfUp(2, 2)).toBe(1);
    expect(roundHalfUp(0, 1000)).toBe(0);
  });

  it('rejects negative numerator and non-positive denominator', () => {
    expect(() => roundHalfUp(-1, 2)).toThrow();
    expect(() => roundHalfUp(1, 0)).toThrow();
  });
});

describe('weight conversions', () => {
  it('grams to mg is integer', () => {
    expect(gramsToMg(18.4)).toBe(18_400);
    expect(gramsToMg(0.001)).toBe(1);
  });

  it('mg to tola uses bazaar convention', () => {
    expect(mgToTola(TOLA_MG)).toBeCloseTo(1, 6);
    expect(mgToTola(11_664 * 2)).toBeCloseTo(2, 6);
  });

  it('formats weight for display', () => {
    expect(formatWeight(18_400, 'g')).toBe('18.400 g');
    expect(formatWeight(TOLA_MG, 'tola')).toBe('1.000 tola');
  });
});

describe('money', () => {
  it('rupees to paisa', () => {
    expect(rupeesToPaisa(1234.56)).toBe(123_456);
  });

  it('formats PKR with sign', () => {
    expect(formatPKR(123_456)).toBe('Rs 1,234.56');
    expect(formatPKR(-5000)).toBe('Rs -50.00');
  });
});

describe('rate normalisation to paisa/gram', () => {
  it('per gram passes through', () => {
    expect(normalizeRateToPaisaPerGram(2_500_00, 'PER_GRAM')).toBe(250_000);
  });

  it('per 10g divides by ten', () => {
    expect(normalizeRateToPaisaPerGram(2_500_000, 'PER_10G')).toBe(250_000);
  });

  it('per tola divides by tola grams', () => {
    // 11.664 g per tola: a rate of Rs 2916 per tola -> 250 rupees/g -> 25000 paisa/g
    const perTolaPaisa = 291_600; // Rs 2916.00 per tola
    expect(normalizeRateToPaisaPerGram(perTolaPaisa, 'PER_TOLA')).toBe(25_000);
  });
});
