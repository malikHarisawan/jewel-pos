/** Shared domain enums. Kept as const-object + union so they round-trip through
 * zod, SQLite CHECK constraints, and TypeScript without drift. */

export const ROLES = ['OWNER', 'MANAGER', 'SALESMAN'] as const;
export type Role = (typeof ROLES)[number];

export const TRACKING_MODES = ['ITEM', 'LOT'] as const;
export type TrackingMode = (typeof TRACKING_MODES)[number];

export const MAKING_MODES = ['PER_GRAM', 'FIXED', 'PCT_OF_METAL'] as const;
export type MakingMode = (typeof MAKING_MODES)[number];

export const ITEM_STATUSES = [
  'IN_STOCK',
  'ON_APPROVAL',
  'SOLD',
  'WITH_KARIGAR',
  'MELTED',
] as const;
export type ItemStatus = (typeof ITEM_STATUSES)[number];

export const ORIGIN_KINDS = ['SUPPLIER', 'KARIGAR', 'IN_HOUSE', 'OLD_GOLD'] as const;
export type OriginKind = (typeof ORIGIN_KINDS)[number];

export const PARTY_KINDS = ['CUSTOMER', 'SUPPLIER', 'KARIGAR'] as const;
export type PartyKind = (typeof PARTY_KINDS)[number];

export const LOCATION_KINDS = ['BRANCH', 'COUNTER', 'SHOWCASE', 'TRAY'] as const;
export type LocationKind = (typeof LOCATION_KINDS)[number];

export const DOC_TYPES = [
  'SALE_INVOICE',
  'PURCHASE',
  'SALE_RETURN',
  // v2 headroom (schema-valid, no v1 UI)
  'APPROVAL_MEMO',
  'KARIGAR_VOUCHER',
  'TRANSFER_NOTE',
  'STOCKTAKE',
] as const;
export type DocType = (typeof DOC_TYPES)[number];

export const DOC_STATUSES = ['DRAFT', 'FINAL', 'CANCELLED'] as const;
export type DocStatus = (typeof DOC_STATUSES)[number];

export const LINE_KINDS = ['ITEM', 'LOT_WEIGHT', 'OLD_GOLD_EXCHANGE', 'RETURN'] as const;
export type LineKind = (typeof LINE_KINDS)[number];

export const PAYMENT_METHODS = ['CASH', 'BANK', 'CARD', 'CREDIT'] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

export const MOVEMENT_TYPES = [
  // v1
  'OPENING',
  'PURCHASE_IN',
  'SALE_OUT',
  'SALE_RETURN_IN',
  'EXCHANGE_IN',
  'ADJUSTMENT',
  // v2 headroom
  'KARIGAR_ISSUE',
  'KARIGAR_RECEIVE',
  'APPROVAL_OUT',
  'APPROVAL_IN',
  'TRANSFER_OUT',
  'TRANSFER_IN',
  'STOCKTAKE_ADJ',
] as const;
export type MovementType = (typeof MOVEMENT_TYPES)[number];

/** Movement types that add stock (deltas must be >= 0). */
export const IN_MOVEMENTS: MovementType[] = [
  'OPENING',
  'PURCHASE_IN',
  'SALE_RETURN_IN',
  'EXCHANGE_IN',
  'KARIGAR_RECEIVE',
  'APPROVAL_IN',
  'TRANSFER_IN',
];

/** Movement types that remove stock (deltas must be <= 0). */
export const OUT_MOVEMENTS: MovementType[] = [
  'SALE_OUT',
  'KARIGAR_ISSUE',
  'APPROVAL_OUT',
  'TRANSFER_OUT',
];

export const REASON_CODES = [
  'DAMAGE',
  'THEFT',
  'WEIGHING_ERROR',
  'DATA_ENTRY_ERROR',
  'MELT',
  'POLISH_LOSS',
  'STOCKTAKE',
  'OTHER',
] as const;
export type ReasonCode = (typeof REASON_CODES)[number];

export const TAX_BASES = ['TOTAL', 'TOTAL_MINUS_METAL'] as const;
export type TaxBase = (typeof TAX_BASES)[number];
