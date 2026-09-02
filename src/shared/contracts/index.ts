/**
 * The API contract — pure data, transport-agnostic. The Electron IPC router and
 * a future LAN HTTP server both loop over THIS object; the renderer's typed
 * client is derived from it via mapped types (no codegen). Each endpoint
 * declares its zod input/output schemas and the roles allowed to call it.
 */
import { z } from 'zod';
import {
  ROLES,
  TRACKING_MODES,
  MAKING_MODES,
  ITEM_STATUSES,
  ORIGIN_KINDS,
  MOVEMENT_TYPES,
  REASON_CODES,
  LINE_KINDS,
  PARTY_KINDS,
} from '../domain/enums.js';

export const RoleSchema = z.enum(ROLES);

// ---- shared shapes --------------------------------------------------------

export const SessionSchema = z.object({
  userId: z.number().int(),
  username: z.string(),
  displayName: z.string(),
  role: RoleSchema,
  loginAt: z.number().int(),
  /** The account is on a handed-out PIN (seeded default or admin reset) and
   * must set its own before the app opens. */
  mustChangePin: z.boolean(),
});
export type SessionDTO = z.infer<typeof SessionSchema>;

// ---- endpoint schemas -----------------------------------------------------

export const PingInput = z.object({ message: z.string() });
export const PingOutput = z.object({ reply: z.string(), at: z.string() });

export const LoginInput = z.object({
  username: z.string().min(1),
  secret: z.string().min(1),
});

export const LogoutOutput = z.object({ ok: z.boolean() });

export const MeOutput = SessionSchema.nullable();

export const PurityDTO = z.object({
  id: z.number().int(),
  metalId: z.number().int(),
  label: z.string(),
  finenessMillesimal: z.number().int(),
});
export const ListPuritiesOutput = z.array(PurityDTO);

// ---- catalog (category axes) ----------------------------------------------

/** A simple lookup row shared by every single-column axis. */
export const AxisOptionDTO = z.object({
  id: z.number().int(),
  name: z.string(),
});
export const LocationDTO = z.object({
  id: z.number().int(),
  name: z.string(),
  kind: z.string(),
});
/** All the reference data an item form needs, in one round-trip. */
export const CatalogOutput = z.object({
  productTypes: z.array(AxisOptionDTO),
  metals: z.array(AxisOptionDTO),
  purities: z.array(PurityDTO),
  stoneTypes: z.array(AxisOptionDTO),
  makingTypes: z.array(AxisOptionDTO),
  occasions: z.array(AxisOptionDTO),
  locations: z.array(LocationDTO),
});

// ---- items ----------------------------------------------------------------

export const TrackingModeSchema = z.enum(TRACKING_MODES);
export const MakingModeSchema = z.enum(MAKING_MODES);
export const ItemStatusSchema = z.enum(ITEM_STATUSES);
export const OriginKindSchema = z.enum(ORIGIN_KINDS);

/** Owner-only cost fields. Absent from a salesman's view (redaction is structural
 * — the service simply omits it for non-owners, and the output schema allows it). */
export const ItemCostDTO = z.object({
  intakeRatePaisaPerGram: z.number().int().nullable(),
  labourPaidPaisa: z.number().int(),
  stoneCostPaisa: z.number().int(),
  otherCostPaisa: z.number().int(),
  landedCostPaisa: z.number().int(),
});

export const CreateItemInput = z
  .object({
    trackingMode: TrackingModeSchema,
    tagNumber: z.string().trim().min(1).optional(),
    name: z.string().trim().min(1),
    productTypeId: z.number().int(),
    metalId: z.number().int(),
    purityId: z.number().int(),
    stoneTypeId: z.number().int(),
    makingTypeId: z.number().int(),
    occasionId: z.number().int().nullable().optional(),
    originKind: OriginKindSchema,
    sourcePartyId: z.number().int().nullable().optional(),
    grossMg: z.number().int().nonnegative(),
    lessMg: z.number().int().nonnegative().default(0),
    netMg: z.number().int().nonnegative(),
    touchBp: z.number().int().min(1).max(10000).nullable().optional(),
    wastageBp: z.number().int().nonnegative().default(0),
    makingMode: MakingModeSchema.default('PER_GRAM'),
    makingRatePaisa: z.number().int().nonnegative().default(0),
    hallmarkNumber: z.string().trim().optional(),
    hallmarkChargePaisa: z.number().int().nonnegative().default(0),
    locationId: z.number().int(),
    notes: z.string().optional(),
    /** Owner-only; ignored if the caller isn't an owner. */
    cost: ItemCostDTO.partial().optional(),
    /** Opening stock to post immediately, if any (pieces + this item's weight). */
    openingPieces: z.number().int().nonnegative().default(0),
  })
  // If the caller gave gross + net but no "less" (the common case for a
  // stone-set piece), derive less = gross - net so they don't have to compute it.
  .transform((v) => (v.lessMg === 0 && v.netMg < v.grossMg ? { ...v, lessMg: v.grossMg - v.netMg } : v))
  .refine((v) => v.netMg === v.grossMg - v.lessMg, {
    message: 'net, gross and less weights do not add up (net must equal gross minus less)',
    path: ['netMg'],
  });

export const UpdateItemInput = z
  .object({
    id: z.number().int(),
    name: z.string().trim().min(1),
    productTypeId: z.number().int(),
    metalId: z.number().int(),
    purityId: z.number().int(),
    stoneTypeId: z.number().int(),
    makingTypeId: z.number().int(),
    occasionId: z.number().int().nullable().optional(),
    originKind: OriginKindSchema,
    sourcePartyId: z.number().int().nullable().optional(),
    grossMg: z.number().int().nonnegative(),
    lessMg: z.number().int().nonnegative().default(0),
    netMg: z.number().int().nonnegative(),
    touchBp: z.number().int().min(1).max(10000).nullable().optional(),
    wastageBp: z.number().int().nonnegative().default(0),
    makingMode: MakingModeSchema.default('PER_GRAM'),
    makingRatePaisa: z.number().int().nonnegative().default(0),
    hallmarkNumber: z.string().trim().optional(),
    hallmarkChargePaisa: z.number().int().nonnegative().default(0),
    locationId: z.number().int(),
    notes: z.string().optional(),
    cost: ItemCostDTO.partial().optional(),
  })
  .transform((v) => (v.lessMg === 0 && v.netMg < v.grossMg ? { ...v, lessMg: v.grossMg - v.netMg } : v))
  .refine((v) => v.netMg === v.grossMg - v.lessMg, {
    message: 'net, gross and less weights do not add up (net must equal gross minus less)',
    path: ['netMg'],
  });

export const ItemDTO = z.object({
  id: z.number().int(),
  trackingMode: TrackingModeSchema,
  tagNumber: z.string().nullable(),
  name: z.string(),
  productTypeId: z.number().int(),
  metalId: z.number().int(),
  purityId: z.number().int(),
  stoneTypeId: z.number().int(),
  makingTypeId: z.number().int(),
  occasionId: z.number().int().nullable(),
  originKind: OriginKindSchema,
  sourcePartyId: z.number().int().nullable(),
  grossMg: z.number().int(),
  lessMg: z.number().int(),
  netMg: z.number().int(),
  touchBp: z.number().int().nullable(),
  wastageBp: z.number().int(),
  makingMode: MakingModeSchema,
  makingRatePaisa: z.number().int(),
  hallmarkNumber: z.string().nullable(),
  hallmarkChargePaisa: z.number().int(),
  status: ItemStatusSchema,
  locationId: z.number().int(),
  notes: z.string().nullable(),
  // live balance (from the ledger)
  balancePieces: z.number().int(),
  balanceNetMg: z.number().int(),
  // owner-only; null for non-owners
  cost: ItemCostDTO.nullable(),
});
export type ItemDTOType = z.infer<typeof ItemDTO>;

export const ListItemsInput = z.object({
  search: z.string().optional(),
  metalId: z.number().int().optional(),
  status: ItemStatusSchema.optional(),
  limit: z.number().int().min(1).max(500).default(100),
});
export const ListItemsOutput = z.array(ItemDTO);

export const GetItemInput = z.object({ id: z.number().int() });

export const CreateItemOutput = z.object({ id: z.number().int(), tagNumber: z.string() });

// ---- stock ledger ---------------------------------------------------------

export const MovementTypeSchema = z.enum(MOVEMENT_TYPES);
export const ReasonCodeSchema = z.enum(REASON_CODES);

/** Bring stock IN for an existing item (purchase or opening top-up). Weight is
 * this item's per-piece weight × pieces for ITEM mode, or an explicit lot weight. */
export const PurchaseInInput = z
  .object({
    itemId: z.number().int(),
    // Weight-only lots (e.g. raw metal) can be topped up with 0 pieces; a normal
    // purchase adds pieces. At least one of pieces/weight must be positive.
    pieces: z.number().int().nonnegative(),
    grossMg: z.number().int().nonnegative(),
    netMg: z.number().int().nonnegative(),
    partyId: z.number().int().nullable().optional(),
    notes: z.string().optional(),
  })
  .refine((v) => v.pieces > 0 || v.netMg > 0, {
    message: 'purchase must add pieces or weight',
  });

/** A signed correction with a mandatory reason (e.g. weighing error, damage). */
export const AdjustmentInput = z.object({
  itemId: z.number().int(),
  piecesDelta: z.number().int(),
  grossMgDelta: z.number().int(),
  netMgDelta: z.number().int(),
  reasonCode: ReasonCodeSchema,
  notes: z.string().optional(),
});

export const ReverseMovementInput = z.object({
  movementId: z.number().int(),
  reasonCode: ReasonCodeSchema,
  notes: z.string().optional(),
});

export const PostMovementOutput = z.object({
  movementId: z.number().int(),
  balance: z.object({
    pieces: z.number().int(),
    grossMg: z.number().int(),
    netMg: z.number().int(),
  }),
});

export const MovementDTO = z.object({
  id: z.number().int(),
  movementType: MovementTypeSchema,
  itemId: z.number().int(),
  itemName: z.string(),
  tagNumber: z.string().nullable(),
  piecesDelta: z.number().int(),
  grossMgDelta: z.number().int(),
  netMgDelta: z.number().int(),
  reasonCode: ReasonCodeSchema.nullable(),
  reversesMovementId: z.number().int().nullable(),
  notes: z.string().nullable(),
  createdAt: z.string(),
  createdByName: z.string(),
});

export const ListMovementsInput = z.object({
  itemId: z.number().int().optional(),
  limit: z.number().int().min(1).max(1000).default(200),
});
export const ListMovementsOutput = z.array(MovementDTO);

/** A per-item stock balance row for the balances table. */
export const BalanceRowDTO = z.object({
  itemId: z.number().int(),
  tagNumber: z.string().nullable(),
  name: z.string(),
  trackingMode: TrackingModeSchema,
  metalId: z.number().int(),
  purityId: z.number().int(),
  pieces: z.number().int(),
  grossMg: z.number().int(),
  netMg: z.number().int(),
  status: ItemStatusSchema,
});
export const ListBalancesInput = z.object({
  search: z.string().optional(),
  nonZeroOnly: z.boolean().default(false),
  limit: z.number().int().min(1).max(1000).default(500),
});
export const ListBalancesOutput = z.array(BalanceRowDTO);

// ---- rates ----------------------------------------------------------------

export const RateBasisSchema = z.enum(['PER_GRAM', 'PER_TOLA', 'PER_10G']);

/** Enter today's rate for a purity. The user types a value in their chosen
 * basis; the service normalises to paisa-per-gram and appends a history row. */
export const EnterRateInput = z.object({
  purityId: z.number().int(),
  enteredValuePaisa: z.number().int().positive(),
  enteredBasis: RateBasisSchema,
});

export const RateDTO = z.object({
  id: z.number().int(),
  purityId: z.number().int(),
  ratePaisaPerGram: z.number().int(),
  enteredValuePaisa: z.number().int(),
  enteredBasis: RateBasisSchema,
  effectiveAt: z.string(),
  enteredByName: z.string(),
});

/** Latest rate per purity (the "today's rate" board). */
export const LatestRateDTO = z.object({
  purityId: z.number().int(),
  label: z.string(),
  metalId: z.number().int(),
  ratePaisaPerGram: z.number().int().nullable(),
  effectiveAt: z.string().nullable(),
});
export const LatestRatesOutput = z.array(LatestRateDTO);

export const RateHistoryInput = z.object({
  purityId: z.number().int().optional(),
  limit: z.number().int().min(1).max(500).default(100),
});
export const RateHistoryOutput = z.array(RateDTO);

// ---- price quote (live item pricing) --------------------------------------

/** A computed price breakdown for one item at the current rate. */
export const QuoteDTO = z.object({
  itemId: z.number().int(),
  hasRate: z.boolean(),
  ratePaisaPerGram: z.number().int().nullable(),
  metalValuePaisa: z.number().int(),
  makingValuePaisa: z.number().int(),
  wastageValuePaisa: z.number().int(),
  stoneValuePaisa: z.number().int(),
  hallmarkChargePaisa: z.number().int(),
  taxPaisa: z.number().int(),
  totalPaisa: z.number().int(),
});
export const QuoteItemInput = z.object({ itemId: z.number().int() });
export const QuoteItemsInput = z.object({ itemIds: z.array(z.number().int()).max(500) });
export const QuoteItemsOutput = z.array(QuoteDTO);

/** Price an item at a chosen net weight (for bulk/lot sales). */
export const QuoteWeightInput = z.object({
  itemId: z.number().int(),
  netMg: z.number().int().positive(),
});
export const QuoteWeightOutput = z.object({
  itemId: z.number().int(),
  hasRate: z.boolean(),
  ratePaisaPerGram: z.number().int().nullable(),
  totalPaisa: z.number().int(),
});

// ---- POS checkout ---------------------------------------------------------

export const CheckoutSaleLineInput = z.object({
  itemId: z.number().int(),
  pieces: z.number().int().positive(),
  netMg: z.number().int().nonnegative(),
  grossMg: z.number().int().nonnegative(),
  lessMg: z.number().int().nonnegative().optional(),
  purityId: z.number().int(),
  wastageBp: z.number().int().nonnegative(),
  making: z.object({ mode: MakingModeSchema, ratePaisa: z.number().int().nonnegative() }),
  stones: z
    .array(
      z.object({
        stoneTypeId: z.number().int(),
        count: z.number().int(),
        totalCaratC: z.number().int(),
        ratePaisaPerCarat: z.number().int(),
      }),
    )
    .default([]),
  hallmarkChargePaisa: z.number().int().nonnegative().default(0),
  discountPaisa: z.number().int().nonnegative().default(0),
  description: z.string(),
});

export const CheckoutOldGoldInput = z.object({
  purityId: z.number().int(),
  netMg: z.number().int().positive(),
  grossMg: z.number().int().positive(),
  touchBp: z.number().int().min(1).max(10000),
  description: z.string(),
});

export const CheckoutPaymentInput = z.object({
  method: z.enum(['CASH', 'BANK', 'CARD', 'CREDIT']),
  amountPaisa: z.number().int(),
  bankRef: z.string().optional(),
});

export const CheckoutInput = z.object({
  customerId: z.number().int().nullable().optional(),
  saleLines: z.array(CheckoutSaleLineInput).min(1),
  oldGoldLines: z.array(CheckoutOldGoldInput).default([]),
  payments: z.array(CheckoutPaymentInput).min(1),
  discountApprovedBy: z.number().int().nullable().optional(),
  /** Signed whole-sale adjustment (negative = discount, positive = surcharge). */
  saleAdjustmentPaisa: z.number().int().default(0),
});

export const CheckoutOutput = z.object({
  documentId: z.number().int(),
  docNumber: z.string(),
  grandTotalPaisa: z.number().int(),
});

// A finalized invoice, for the receipt view.
export const InvoiceLineDTO = z.object({
  lineKind: z.enum(LINE_KINDS),
  description: z.string(),
  pieces: z.number().int(),
  netMg: z.number().int(),
  ratePaisaPerGram: z.number().int(),
  metalValuePaisa: z.number().int(),
  makingValuePaisa: z.number().int(),
  wastageValuePaisa: z.number().int(),
  stoneValuePaisa: z.number().int(),
  hallmarkChargePaisa: z.number().int(),
  taxPaisa: z.number().int(),
  lineTotalPaisa: z.number().int(),
});
export const InvoiceDTO = z.object({
  id: z.number().int(),
  docNumber: z.string().nullable(),
  docDate: z.string(),
  customerName: z.string().nullable(),
  lines: z.array(InvoiceLineDTO),
  payments: z.array(z.object({ method: z.string(), amountPaisa: z.number().int() })),
  metalValuePaisa: z.number().int(),
  makingValuePaisa: z.number().int(),
  wastageValuePaisa: z.number().int(),
  stoneValuePaisa: z.number().int(),
  hallmarkValuePaisa: z.number().int(),
  exchangeValuePaisa: z.number().int(),
  discountPaisa: z.number().int(),
  taxPaisa: z.number().int(),
  roundingPaisa: z.number().int(),
  saleAdjustmentPaisa: z.number().int(),
  grandTotalPaisa: z.number().int(),
});
export const GetInvoiceInput = z.object({ id: z.number().int() });

// The sales register — one row per finalised invoice.
export const InvoiceListRowDTO = z.object({
  id: z.number().int(),
  docNumber: z.string().nullable(),
  docDate: z.string(),
  status: z.enum(['FINAL', 'CANCELLED']),
  grandTotalPaisa: z.number().int(),
  customerName: z.string().nullable(),
  lineCount: z.number().int(),
  cashierName: z.string().nullable(),
});
export const ListInvoicesInput = z.object({
  fromDate: z.string().nullable().optional(),
  toDate: z.string().nullable().optional(),
  search: z.string().nullable().optional(),
  limit: z.number().int().min(1).max(500).optional(),
  offset: z.number().int().min(0).optional(),
});
export const ListInvoicesOutput = z.array(InvoiceListRowDTO);

// ---- sale returns ---------------------------------------------------------

export const ReturnableLineDTO = z.object({
  lineId: z.number().int(),
  lineNo: z.number().int(),
  itemId: z.number().int().nullable(),
  description: z.string(),
  lineKind: z.enum(LINE_KINDS),
  pieces: z.number().int(),
  netMg: z.number().int(),
  grossMg: z.number().int(),
  lineTotalPaisa: z.number().int(),
  returnedPieces: z.number().int(),
  returnedNetMg: z.number().int(),
  remainingPieces: z.number().int(),
  remainingNetMg: z.number().int(),
});
export const ReturnableLinesInput = z.object({ documentId: z.number().int() });
export const ReturnableLinesOutput = z.array(ReturnableLineDTO);

export const ReturnSaleInput = z.object({
  documentId: z.number().int(),
  lines: z
    .array(
      z.object({
        lineId: z.number().int(),
        pieces: z.number().int().positive(),
        netMg: z.number().int().positive(),
      }),
    )
    .min(1),
  refundMethod: z.enum(['CASH', 'BANK', 'CARD', 'CREDIT']).optional(),
  reason: z.string().nullable().optional(),
});
export const ReturnSaleOutput = z.object({
  documentId: z.number().int(),
  docNumber: z.string(),
  grandTotalPaisa: z.number().int(),
});

// ---- parties (customers / suppliers / karigars) ---------------------------

export const PartyKindSchema = z.enum(PARTY_KINDS);
export const PartyDTO = z.object({
  id: z.number().int(),
  kind: PartyKindSchema,
  name: z.string(),
  phone: z.string().nullable(),
  cnic: z.string().nullable(),
  address: z.string().nullable(),
  notes: z.string().nullable(),
});
export const CreatePartyInput = z.object({
  kind: PartyKindSchema,
  name: z.string().trim().min(1),
  phone: z.string().trim().optional(),
  cnic: z.string().trim().optional(),
  address: z.string().trim().optional(),
  notes: z.string().trim().optional(),
});
export const ListPartiesInput = z.object({
  kind: PartyKindSchema.optional(),
  search: z.string().optional(),
  limit: z.number().int().min(1).max(500).default(200),
});
export const ListPartiesOutput = z.array(PartyDTO);

// ---- karigar (goldsmith) jobs ---------------------------------------------

export const JobStatusSchema = z.enum(['OPEN', 'RECEIVED', 'CANCELLED']);

export const KarigarJobDTO = z.object({
  id: z.number().int(),
  jobNumber: z.string().nullable(),
  karigarPartyId: z.number().int(),
  karigarName: z.string(),
  purityId: z.number().int(),
  purityLabel: z.string(),
  status: JobStatusSchema,
  issuedGrossMg: z.number().int(),
  issuedNetMg: z.number().int(),
  allowedWastageBp: z.number().int(),
  labourRatePaisa: z.number().int(),
  receivedNetMg: z.number().int().nullable(),
  actualWastageMg: z.number().int().nullable(),
  overTolerance: z.boolean(),
  labourPaidPaisa: z.number().int(),
  issuedAt: z.string(),
  receivedAt: z.string().nullable(),
  notes: z.string().nullable(),
});

export const IssueJobInput = z.object({
  karigarPartyId: z.number().int(),
  purityId: z.number().int(),
  issuedGrossMg: z.number().int().positive(),
  issuedNetMg: z.number().int().positive(),
  allowedWastageBp: z.number().int().nonnegative().default(0),
  labourRatePaisa: z.number().int().nonnegative().default(0),
});

export const ReceiveJobPieceInput = z.object({
  name: z.string().trim().min(1),
  tagNumber: z.string().trim().optional(),
  productTypeId: z.number().int().optional(),
  grossMg: z.number().int().nonnegative(),
  netMg: z.number().int().nonnegative(),
});
export const ReceiveJobInput = z.object({
  jobId: z.number().int(),
  pieces: z.array(ReceiveJobPieceInput).min(1),
  labourPaidPaisa: z.number().int().nonnegative().default(0),
  notes: z.string().trim().optional(),
});

export const ListJobsInput = z.object({
  status: JobStatusSchema.optional(),
  karigarPartyId: z.number().int().optional(),
  limit: z.number().int().min(1).max(500).default(200),
});
export const ListJobsOutput = z.array(KarigarJobDTO);

export const KarigarAccountDTO = z.object({
  karigarPartyId: z.number().int(),
  karigarName: z.string(),
  holdingMg: z.number().int(),
  totalIssuedMg: z.number().int(),
  totalReceivedMg: z.number().int(),
  overToleranceJobs: z.number().int(),
  jobCount: z.number().int(),
});
export const KarigarAccountsOutput = z.array(KarigarAccountDTO);

export const RawBalanceInput = z.object({ purityId: z.number().int() });
export const RawBalanceOutput = z.object({ netMg: z.number().int() });

export const RawIntakeInput = z.object({
  purityId: z.number().int(),
  netMg: z.number().int().positive(),
  partyId: z.number().int().nullable().optional(),
  notes: z.string().trim().optional(),
});
export const RawBalanceRowDTO = z.object({
  purityId: z.number().int(),
  purityLabel: z.string(),
  metalName: z.string(),
  netMg: z.number().int(),
});
export const RawBalancesOutput = z.array(RawBalanceRowDTO);

// ---- settings -------------------------------------------------------------

export const SettingsDTO = z.object({
  shop_name: z.string(),
  shop_address: z.string(),
  shop_phone: z.string(),
  tax_rate_bp: z.string(),
  tax_base: z.string(),
  invoice_round_to: z.string(),
  tola_mg: z.string(),
  idle_lock_minutes: z.string(),
  /** Whole-percent discount ceilings, enforced server-side per role. */
  max_discount_pct_salesman: z.string(),
  max_discount_pct_manager: z.string(),
});
export const UpdateSettingsInput = z.object({
  shop_name: z.string().optional(),
  shop_address: z.string().optional(),
  shop_phone: z.string().optional(),
  tax_rate_bp: z.string().optional(),
  tax_base: z.enum(['TOTAL', 'TOTAL_MINUS_METAL']).optional(),
  invoice_round_to: z.enum(['1', '100']).optional(),
  tola_mg: z.string().optional(),
  idle_lock_minutes: z.string().optional(),
  max_discount_pct_salesman: z.string().optional(),
  max_discount_pct_manager: z.string().optional(),
});

// ---- user management ------------------------------------------------------

export const UserDTO = z.object({
  id: z.number().int(),
  username: z.string(),
  displayName: z.string(),
  role: RoleSchema,
  isActive: z.boolean(),
});
export const ListUsersOutput = z.array(UserDTO);
export const CreateUserInput = z.object({
  username: z.string().trim().min(1),
  displayName: z.string().trim().min(1),
  secret: z.string().min(4),
  role: RoleSchema,
});
export const SetUserActiveInput = z.object({ userId: z.number().int(), active: z.boolean() });
export const ResetPinInput = z.object({ userId: z.number().int(), newSecret: z.string().min(4) });
export const ChangeOwnPinInput = z.object({
  currentSecret: z.string().min(1),
  newSecret: z.string().min(4),
});
export const OkOutput = z.object({ ok: z.boolean() });

// ---- licensing ------------------------------------------------------------

export const LicenseInfoDTO = z.object({
  status: z.enum(['TRIAL', 'GRACE', 'LICENSED', 'EXPIRED']),
  machineId: z.string(),
  daysLeft: z.number().int(),
  inGrace: z.boolean(),
  licensedUntil: z.string().nullable(),
});
export const ActivateLicenseInput = z.object({ code: z.string().min(1) });

// ---- dashboard summary ----------------------------------------------------

export const DashboardSummaryOutput = z.object({
  totalItems: z.number().int(),
  totalPieces: z.number().int(),
  totalNetMg: z.number().int(),
  /** Melt value of stock at each purity's latest rate — metal only. */
  totalValuePaisa: z.number().int(),
  /** Net weight sitting in purities that have no rate yet, so it is unvalued. */
  unratedNetMg: z.number().int(),
  byMetal: z.array(
    z.object({
      metalId: z.number().int(),
      metalName: z.string(),
      items: z.number().int(),
      netMg: z.number().int(),
      valuePaisa: z.number().int(),
    }),
  ),
  byCategory: z.array(
    z.object({
      productTypeId: z.number().int(),
      productTypeName: z.string(),
      items: z.number().int(),
      netMg: z.number().int(),
      valuePaisa: z.number().int(),
    }),
  ),
});

// ---- the contract ---------------------------------------------------------

export interface EndpointDef {
  input: z.ZodType;
  output: z.ZodType;
  /** Roles permitted to call. Empty means "any authenticated user". Absent means "public". */
  roles?: readonly string[];
  /** When true, callable without a session (only `auth.login`, `system.ping`). */
  public?: boolean;
}

export const contract = {
  'system.ping': { input: PingInput, output: PingOutput, public: true },
  'auth.login': { input: LoginInput, output: SessionSchema, public: true },
  'auth.logout': { input: z.object({}), output: LogoutOutput },
  'auth.me': { input: z.object({}), output: MeOutput, public: true },
  'catalog.purities': { input: z.object({}), output: ListPuritiesOutput },
  'catalog.all': { input: z.object({}), output: CatalogOutput },
  'items.list': { input: ListItemsInput, output: ListItemsOutput },
  'items.get': { input: GetItemInput, output: ItemDTO },
  'items.create': {
    input: CreateItemInput,
    output: CreateItemOutput,
    roles: ['OWNER', 'MANAGER'],
  },
  'items.update': {
    input: UpdateItemInput,
    output: ItemDTO,
    roles: ['OWNER', 'MANAGER'],
  },
  'stock.balances': { input: ListBalancesInput, output: ListBalancesOutput },
  'stock.movements': { input: ListMovementsInput, output: ListMovementsOutput },
  'stock.purchaseIn': {
    input: PurchaseInInput,
    output: PostMovementOutput,
    roles: ['OWNER', 'MANAGER'],
  },
  'stock.adjust': {
    input: AdjustmentInput,
    output: PostMovementOutput,
    roles: ['OWNER', 'MANAGER'],
  },
  'stock.reverse': {
    input: ReverseMovementInput,
    output: PostMovementOutput,
    roles: ['OWNER', 'MANAGER'],
  },
  'rates.latest': { input: z.object({}), output: LatestRatesOutput },
  'rates.history': { input: RateHistoryInput, output: RateHistoryOutput },
  'rates.enter': { input: EnterRateInput, output: RateDTO, roles: ['OWNER', 'MANAGER'] },
  'rates.quoteItems': { input: QuoteItemsInput, output: QuoteItemsOutput },
  'rates.quoteWeight': { input: QuoteWeightInput, output: QuoteWeightOutput },
  'sales.checkout': { input: CheckoutInput, output: CheckoutOutput, roles: ['OWNER', 'MANAGER', 'SALESMAN'] },
  'sales.getInvoice': { input: GetInvoiceInput, output: InvoiceDTO },
  // The register is a management view: a salesman rings sales up but does not
  // get to browse the day's takings.
  'sales.list': {
    input: ListInvoicesInput,
    output: ListInvoicesOutput,
    roles: ['OWNER', 'MANAGER'],
  },
  'sales.returnableLines': {
    input: ReturnableLinesInput,
    output: ReturnableLinesOutput,
    roles: ['OWNER', 'MANAGER'],
  },
  // Taking goods back moves money OUT of the till, so it is not a salesman's
  // call — same bar as browsing the register.
  'sales.return': {
    input: ReturnSaleInput,
    output: ReturnSaleOutput,
    roles: ['OWNER', 'MANAGER'],
  },
  'parties.list': { input: ListPartiesInput, output: ListPartiesOutput },
  'parties.create': { input: CreatePartyInput, output: PartyDTO, roles: ['OWNER', 'MANAGER'] },
  'karigar.jobs': { input: ListJobsInput, output: ListJobsOutput },
  'karigar.accounts': { input: z.object({}), output: KarigarAccountsOutput },
  'karigar.rawBalance': { input: RawBalanceInput, output: RawBalanceOutput },
  'karigar.rawBalances': { input: z.object({}), output: RawBalancesOutput },
  'karigar.rawIntake': { input: RawIntakeInput, output: RawBalanceOutput, roles: ['OWNER', 'MANAGER'] },
  'karigar.issue': { input: IssueJobInput, output: KarigarJobDTO, roles: ['OWNER', 'MANAGER'] },
  'karigar.receive': { input: ReceiveJobInput, output: KarigarJobDTO, roles: ['OWNER', 'MANAGER'] },
  'settings.get': { input: z.object({}), output: SettingsDTO },
  'settings.update': { input: UpdateSettingsInput, output: SettingsDTO, roles: ['OWNER', 'MANAGER'] },
  'users.list': { input: z.object({}), output: ListUsersOutput, roles: ['OWNER', 'MANAGER'] },
  'users.create': { input: CreateUserInput, output: UserDTO, roles: ['OWNER'] },
  'users.setActive': { input: SetUserActiveInput, output: OkOutput, roles: ['OWNER'] },
  'users.resetPin': { input: ResetPinInput, output: OkOutput, roles: ['OWNER'] },
  'users.changeOwnPin': { input: ChangeOwnPinInput, output: OkOutput },
  'license.status': { input: z.object({}), output: LicenseInfoDTO, public: true },
  'license.activate': { input: ActivateLicenseInput, output: LicenseInfoDTO, public: true },
  'dashboard.summary': { input: z.object({}), output: DashboardSummaryOutput },
} as const satisfies Record<string, EndpointDef>;

export type Contract = typeof contract;
export type Channel = keyof Contract;

/** The typed API surface shared by the IPC client and (future) HTTP client.
 * Inputs use z.input so fields with a server-side default are optional for the
 * caller; outputs use z.infer (fully resolved). */
export type Api = {
  [K in Channel]: (input: z.input<Contract[K]['input']>) => Promise<z.infer<Contract[K]['output']>>;
};

export const CHANNELS = Object.keys(contract) as Channel[];
