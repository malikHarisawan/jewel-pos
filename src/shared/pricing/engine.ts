/**
 * Pure jewellery pricing engine. No DB, no clock, no globals.
 *
 * Deterministic by contract: identical inputs must yield identical paisa
 * forever, so a stored invoice can be re-verified years later. All arithmetic
 * is integer paisa / milligram / basis-point; rounding happens ONCE per money
 * component (never on intermediates), so line totals are exact sums of their
 * rounded parts and the whole thing reconciles.
 */
import { roundHalfUp } from '../units/index.js';
import type { MakingMode, TaxBase } from '../domain/enums.js';

export interface StoneInput {
  /** carat x 100 */
  totalCaratC: number;
  ratePaisaPerCarat: number;
}

export interface PricingItemInput {
  netMg: number;
  wastageBp: number;
  making: { mode: MakingMode; ratePaisa: number }; // paisa/g | fixed paisa | bp when PCT_OF_METAL
  stones: StoneInput[];
  hallmarkChargePaisa: number;
}

export interface RateSnapshot {
  purityId: number;
  metalRateId: number;
  ratePaisaPerGram: number;
}

export interface TaxConfig {
  rateBp: number;
  /** FBR: gold value is exempt -> TOTAL_MINUS_METAL. */
  base: TaxBase;
}

export interface DiscountInput {
  paisa: number;
  approvedByUserId?: number;
}

/** Itemised split, column-for-column with document_lines. */
export interface LineBreakdown {
  metalValuePaisa: number;
  makingValuePaisa: number;
  wastageValuePaisa: number;
  stoneValuePaisa: number;
  hallmarkChargePaisa: number;
  discountPaisa: number;
  taxableBasePaisa: number;
  taxPaisa: number;
  /** Negative for old-gold exchange lines. */
  lineTotalPaisa: number;
}

// ---- component formulas ---------------------------------------------------

function metalValue(netMg: number, ratePaisaPerGram: number): number {
  // netMg * rate / 1000  (mg -> g)
  return roundHalfUp(netMg * ratePaisaPerGram, 1000);
}

function wastageValue(netMg: number, wastageBp: number, ratePaisaPerGram: number): number {
  // netMg * (wastageBp/10000) * rate / 1000
  return roundHalfUp(netMg * wastageBp * ratePaisaPerGram, 10_000 * 1000);
}

function makingValue(
  netMg: number,
  making: { mode: MakingMode; ratePaisa: number },
  metalValuePaisa: number,
): number {
  switch (making.mode) {
    case 'PER_GRAM':
      return roundHalfUp(netMg * making.ratePaisa, 1000);
    case 'FIXED':
      return making.ratePaisa;
    case 'PCT_OF_METAL':
      return roundHalfUp(metalValuePaisa * making.ratePaisa, 10_000); // ratePaisa holds bp
    default: {
      const _exhaustive: never = making.mode;
      throw new Error(`Unknown making mode: ${_exhaustive as string}`);
    }
  }
}

function stoneValue(stones: StoneInput[]): number {
  let total = 0;
  for (const s of stones) {
    // caratC/100 carats * ratePaisaPerCarat
    total += roundHalfUp(s.totalCaratC * s.ratePaisaPerCarat, 100);
  }
  return total;
}

// ---- public API ------------------------------------------------------------

export function priceSaleLine(
  item: PricingItemInput,
  rate: RateSnapshot,
  discount: DiscountInput,
  tax: TaxConfig,
): LineBreakdown {
  const metal = metalValue(item.netMg, rate.ratePaisaPerGram);
  const wastage = wastageValue(item.netMg, item.wastageBp, rate.ratePaisaPerGram);
  const making = makingValue(item.netMg, item.making, metal);
  const stone = stoneValue(item.stones);
  const hallmark = item.hallmarkChargePaisa;
  const disc = discount.paisa;

  const metalPart = tax.base === 'TOTAL_MINUS_METAL' ? 0 : metal;
  const taxableBase = metalPart + making + wastage + stone + hallmark - disc;
  const taxPaisa = taxableBase > 0 ? roundHalfUp(taxableBase * tax.rateBp, 10_000) : 0;

  const lineTotal = metal + making + wastage + stone + hallmark - disc + taxPaisa;

  return {
    metalValuePaisa: metal,
    makingValuePaisa: making,
    wastageValuePaisa: wastage,
    stoneValuePaisa: stone,
    hallmarkChargePaisa: hallmark,
    discountPaisa: disc,
    taxableBasePaisa: taxableBase,
    taxPaisa,
    lineTotalPaisa: lineTotal,
  };
}

/**
 * Old-gold brought in by the customer, valued as pure metal by assay (touch),
 * credited against the invoice as a NEGATIVE line. No making/stone/tax.
 */
export function priceOldGoldLine(
  netMg: number,
  touchBp: number,
  rate: RateSnapshot,
): LineBreakdown {
  // magnitude = netMg * (touchBp/10000) * rate / 1000
  const magnitude = roundHalfUp(netMg * touchBp * rate.ratePaisaPerGram, 10_000 * 1000);
  return {
    metalValuePaisa: -magnitude,
    makingValuePaisa: 0,
    wastageValuePaisa: 0,
    stoneValuePaisa: 0,
    hallmarkChargePaisa: 0,
    discountPaisa: 0,
    taxableBasePaisa: 0,
    taxPaisa: 0,
    lineTotalPaisa: -magnitude,
  };
}

export interface DocumentTotals {
  metalValuePaisa: number;
  makingValuePaisa: number;
  wastageValuePaisa: number;
  stoneValuePaisa: number;
  hallmarkChargePaisa: number;
  discountPaisa: number;
  taxPaisa: number;
  /** Sum of all line totals before final rupee rounding. */
  subtotalPaisa: number;
  /** Adjustment applied to reach a whole-rupee grand total. May be negative. */
  roundingPaisa: number;
  grandTotalPaisa: number;
}

/**
 * Sum lines and round the grand total to the nearest `roundTo` paisa
 * (100 = nearest rupee, 1 = no rounding). The rounding delta is returned
 * explicitly so that subtotal + rounding === grandTotal, always.
 */
export function totalDocument(lines: LineBreakdown[], roundTo: 1 | 100 = 100): DocumentTotals {
  const acc: DocumentTotals = {
    metalValuePaisa: 0,
    makingValuePaisa: 0,
    wastageValuePaisa: 0,
    stoneValuePaisa: 0,
    hallmarkChargePaisa: 0,
    discountPaisa: 0,
    taxPaisa: 0,
    subtotalPaisa: 0,
    roundingPaisa: 0,
    grandTotalPaisa: 0,
  };

  for (const l of lines) {
    acc.metalValuePaisa += l.metalValuePaisa;
    acc.makingValuePaisa += l.makingValuePaisa;
    acc.wastageValuePaisa += l.wastageValuePaisa;
    acc.stoneValuePaisa += l.stoneValuePaisa;
    acc.hallmarkChargePaisa += l.hallmarkChargePaisa;
    acc.discountPaisa += l.discountPaisa;
    acc.taxPaisa += l.taxPaisa;
    acc.subtotalPaisa += l.lineTotalPaisa;
  }

  const grand = roundToNearest(acc.subtotalPaisa, roundTo);
  acc.roundingPaisa = grand - acc.subtotalPaisa;
  acc.grandTotalPaisa = grand;
  return acc;
}

/** Nearest multiple of `step`, half away from zero, sign-safe. */
function roundToNearest(value: number, step: 1 | 100): number {
  if (step === 1) return value;
  const sign = value < 0 ? -1 : 1;
  const mag = Math.abs(value);
  return sign * Math.floor((mag + step / 2) / step) * step;
}
