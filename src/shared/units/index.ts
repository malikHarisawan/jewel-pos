/**
 * Integer-only money & weight primitives. NO floats ever reach storage or pricing.
 *
 *  - money:  integer paisa            (100 paisa = 1 PKR)
 *  - weight: integer milligrams (mg)  (1000 mg = 1 gram)
 *  - stones: integer centipoints      (carat x 100)
 *  - percent: integer basis points    (10000 bp = 100%)
 *
 * Tola and rupee/gram displays are FORMATTING concerns handled here; nothing
 * downstream stores or prices in those units.
 *
 * This module is pure (no Node/Electron imports) so the future LAN server can
 * reuse it unchanged.
 */

/** Pakistani bazaar convention. Overridable per-shop via app_settings.tola_mg. */
export const TOLA_MG = 11_664;
export const MG_PER_GRAM = 1_000;
export const PAISA_PER_RUPEE = 100;
export const BP_DENOM = 10_000;
export const CARAT_C_DENOM = 100;

/**
 * Round a non-negative rational a/b to the nearest integer, half up.
 * Callers pass already-non-negative numerators; sign is handled by the caller
 * (e.g. old-gold lines negate the rounded magnitude).
 */
export function roundHalfUp(numerator: number, denominator: number): number {
  if (denominator <= 0) throw new Error('roundHalfUp: denominator must be positive');
  if (numerator < 0) throw new Error('roundHalfUp: numerator must be non-negative');
  return Math.floor((numerator + denominator / 2) / denominator);
}

// ---- weight ---------------------------------------------------------------

export function gramsToMg(grams: number): number {
  return Math.round(grams * MG_PER_GRAM);
}

/** milligrams -> grams as a float, for DISPLAY only. */
export function mgToGrams(mg: number): number {
  return mg / MG_PER_GRAM;
}

/** milligrams -> tola as a float, for DISPLAY only. */
export function mgToTola(mg: number, tolaMg: number = TOLA_MG): number {
  return mg / tolaMg;
}

export type WeightUnit = 'g' | 'tola';

/** Human-readable weight string, e.g. "18.400 g" or "1.578 tola". */
export function formatWeight(
  mg: number,
  unit: WeightUnit = 'g',
  tolaMg: number = TOLA_MG,
  fractionDigits = 3,
): string {
  const value = unit === 'tola' ? mgToTola(mg, tolaMg) : mgToGrams(mg);
  return `${value.toFixed(fractionDigits)} ${unit}`;
}

// ---- money ----------------------------------------------------------------

export function rupeesToPaisa(rupees: number): number {
  return Math.round(rupees * PAISA_PER_RUPEE);
}

export function paisaToRupees(paisa: number): number {
  return paisa / PAISA_PER_RUPEE;
}

/**
 * Format paisa as PKR. Uses grouping; keeps sign. Negative for exchange/refund.
 * Example: -123456 -> "Rs -1,234.56".
 */
export function formatPKR(paisa: number, withSymbol = true): string {
  const rupees = paisaToRupees(paisa);
  const body = rupees.toLocaleString('en-PK', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return withSymbol ? `Rs ${body}` : body;
}

// ---- rate normalisation ---------------------------------------------------

export type RateBasis = 'PER_GRAM' | 'PER_TOLA' | 'PER_10G';

/**
 * Convert a rate a shopkeeper typed (per gram / per tola / per 10g, in paisa)
 * into the canonical paisa-per-gram used everywhere in pricing.
 */
export function normalizeRateToPaisaPerGram(
  enteredPaisa: number,
  basis: RateBasis,
  tolaMg: number = TOLA_MG,
): number {
  switch (basis) {
    case 'PER_GRAM':
      return enteredPaisa;
    case 'PER_10G':
      return roundHalfUp(enteredPaisa, 10);
    case 'PER_TOLA':
      // paisa per tola -> paisa per gram: divide by (tolaMg/1000) grams
      return roundHalfUp(enteredPaisa * MG_PER_GRAM, tolaMg);
    default: {
      const _exhaustive: never = basis;
      throw new Error(`Unknown rate basis: ${_exhaustive as string}`);
    }
  }
}
