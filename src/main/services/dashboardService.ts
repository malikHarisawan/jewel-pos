/** Dashboard summary — headline stock figures derived from live balances.
 * Only IN_STOCK, positive-balance items count. Excludes the internal RAW-/SCRAP-
 * lots so the numbers reflect sellable inventory. */
import type { DB } from '../db/connection.js';

export interface DashboardSummary {
  totalItems: number;
  totalPieces: number;
  totalNetMg: number;
  /** Metal value of the stock at each purity's latest rate, in paisa. Excludes
   * making, wastage and stones — it is the melt value, not the sale value. */
  totalValuePaisa: number;
  /** Net weight that could not be valued because its purity has no rate yet. */
  unratedNetMg: number;
  byMetal: Array<{
    metalId: number;
    metalName: string;
    items: number;
    netMg: number;
    valuePaisa: number;
  }>;
  byCategory: Array<{
    productTypeId: number;
    productTypeName: string;
    items: number;
    netMg: number;
    valuePaisa: number;
  }>;
}

/** Shared WHERE: sellable, in-stock, non-internal lots with a positive balance. */
const SELLABLE = `
  i.status = 'IN_STOCK'
  AND (i.tag_number IS NULL OR (i.tag_number NOT LIKE 'RAW-%' AND i.tag_number NOT LIKE 'SCRAP-%'))
  AND COALESCE(b.net_mg, 0) > 0`;

/** Latest rate per purity — the same "today's rate" rule the quoting path uses.
 * metal_rates is append-only, so the highest id per purity is the current one. */
const LATEST_RATE = `
  LEFT JOIN metal_rates r ON r.id = (
    SELECT r2.id FROM metal_rates r2
    WHERE r2.purity_id = i.purity_id
    ORDER BY r2.effective_at DESC, r2.id DESC
    LIMIT 1
  )`;

/** net_mg * paisa-per-gram / 1000, rounded half up, in SQL integer arithmetic.
 * NULL rate (purity never priced) contributes 0 rather than poisoning the sum. */
const VALUE_EXPR = `COALESCE(SUM((b.net_mg * r.rate_paisa_per_gram + 500) / 1000), 0)`;

export function getSummary(db: DB): DashboardSummary {
  const totals = db
    .prepare(
      `SELECT COUNT(*) AS items,
              COALESCE(SUM(b.pieces), 0) AS pieces,
              COALESCE(SUM(b.net_mg), 0) AS net_mg,
              ${VALUE_EXPR} AS value_paisa,
              COALESCE(SUM(CASE WHEN r.id IS NULL THEN b.net_mg ELSE 0 END), 0) AS unrated_net_mg
       FROM items i
       LEFT JOIN item_balances b ON b.item_id = i.id
       ${LATEST_RATE}
       WHERE ${SELLABLE}`,
    )
    .get() as {
    items: number;
    pieces: number;
    net_mg: number;
    value_paisa: number;
    unrated_net_mg: number;
  };

  const byMetal = db
    .prepare(
      `SELECT m.id AS metal_id, m.name AS metal_name,
              COUNT(*) AS items, COALESCE(SUM(b.net_mg), 0) AS net_mg,
              ${VALUE_EXPR} AS value_paisa
       FROM items i
       JOIN metals m ON m.id = i.metal_id
       LEFT JOIN item_balances b ON b.item_id = i.id
       ${LATEST_RATE}
       WHERE ${SELLABLE}
       GROUP BY m.id, m.name
       ORDER BY m.sort_order`,
    )
    .all() as Array<{
    metal_id: number;
    metal_name: string;
    items: number;
    net_mg: number;
    value_paisa: number;
  }>;

  const byCategory = db
    .prepare(
      `SELECT pt.id AS pt_id, pt.name AS pt_name,
              COUNT(*) AS items, COALESCE(SUM(b.net_mg), 0) AS net_mg,
              ${VALUE_EXPR} AS value_paisa
       FROM items i
       JOIN product_types pt ON pt.id = i.product_type_id
       LEFT JOIN item_balances b ON b.item_id = i.id
       ${LATEST_RATE}
       WHERE ${SELLABLE}
       GROUP BY pt.id, pt.name
       ORDER BY value_paisa DESC, net_mg DESC`,
    )
    .all() as Array<{
    pt_id: number;
    pt_name: string;
    items: number;
    net_mg: number;
    value_paisa: number;
  }>;

  return {
    totalItems: totals.items,
    totalPieces: totals.pieces,
    totalNetMg: totals.net_mg,
    totalValuePaisa: totals.value_paisa,
    unratedNetMg: totals.unrated_net_mg,
    byMetal: byMetal.map((r) => ({
      metalId: r.metal_id,
      metalName: r.metal_name,
      items: r.items,
      netMg: r.net_mg,
      valuePaisa: r.value_paisa,
    })),
    byCategory: byCategory.map((r) => ({
      productTypeId: r.pt_id,
      productTypeName: r.pt_name,
      items: r.items,
      netMg: r.net_mg,
      valuePaisa: r.value_paisa,
    })),
  };
}
