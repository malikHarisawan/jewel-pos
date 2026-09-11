import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router';
import { Spin, Tooltip } from 'antd';
import { api } from '../../lib/api.js';
import { useStickyState } from '../../lib/useStickyState.js';
import { useCatalog } from './useCatalog.js';
import { useSession } from '../../app/session.js';
import { Screen } from '../../app/AppShell.js';
import { rs, trio, gu } from '../../lib/format.js';
import type { ItemDTOType } from '../../../../shared/contracts/index.js';

const STATUS_CLS: Record<string, string> = {
  IN_STOCK: 'tag tag-accent-2',
  ON_APPROVAL: 'tag tag-accent',
  SOLD: 'tag tag-neutral',
  WITH_KARIGAR: 'tag tag-neutral',
  MELTED: 'tag tag-outline',
};

/** The catalogue. The price column is computed live from today's rate — no
 * price is ever stored against an item, so a rate change re-prices the shelf. */
export function ItemListScreen() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const catalog = useCatalog();
  const { session } = useSession();
  const isOwner = session?.role === 'OWNER';
  const [search, setSearch] = useStickyState('items.search', '');

  const items = useQuery({
    queryKey: ['items', 'list', search],
    queryFn: () => api['items.list']({ search: search || undefined, limit: 200 }),
  });

  const itemIds = useMemo(() => (items.data ?? []).map((i) => i.id), [items.data]);
  // Live price at today's rate for the visible items. Keyed on the id list so it
  // refetches when the list changes; also invalidated when a rate is entered.
  const quotes = useQuery({
    queryKey: ['items', 'quotes', itemIds],
    queryFn: () => api['rates.quoteItems']({ itemIds }),
    enabled: itemIds.length > 0,
  });
  const quoteById = useMemo(() => {
    const m = new Map<number, { hasRate: boolean; totalPaisa: number }>();
    (quotes.data ?? []).forEach((q) => m.set(q.itemId, q));
    return m;
  }, [quotes.data]);

  const names = useMemo(() => {
    const purity = new Map<number, string>();
    const type = new Map<number, string>();
    const location = new Map<number, string>();
    if (catalog.data) {
      catalog.data.purities.forEach((x) => purity.set(x.id, x.label));
      catalog.data.productTypes.forEach((x) => type.set(x.id, x.name));
      catalog.data.locations.forEach((x) => location.set(x.id, x.name));
    }
    return { purity, type, location };
  }, [catalog.data]);

  const rows = items.data ?? [];

  return (
    <Screen
      title={t('nav.items')}
      subtitle="Your catalogue: one row per piece, and what it is worth right now. Where stock came from is on Purchases."
      actions={
        <>
          <input
            className="input"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t('items.searchPh')}
            style={{ width: 260 }}
          />
          <button className="btn btn-primary" onClick={() => navigate('/items/new')}>
            {t('items.add')}
          </button>
        </>
      }
    >
      <div style={{ background: 'var(--color-surface)', borderRadius: 24, padding: '8px 18px 14px' }}>
        <div style={{ overflowX: 'auto' }}>
          <table className="table jp-num">
            <thead>
              <tr>
                <th>{t('items.col.tag')}</th>
                <th>{t('items.col.name')}</th>
                <th>Mode</th>
                <th>Gross − Less = Net</th>
                <th>{t('items.col.balance')}</th>
                <th>{t('items.col.price')}</th>
                <th>{t('items.col.status')}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.map((r: ItemDTOType) => {
                const q = quoteById.get(r.id);
                return (
                  <tr key={r.id}>
                    <td data-num style={{ fontSize: 12, opacity: 0.65 }}>{r.tagNumber ?? '—'}</td>
                    <td>
                      <div style={{ fontWeight: 600 }}>{r.name}</div>
                      <div style={{ fontSize: 11, opacity: 0.5 }}>
                        {[
                          names.type.get(r.productTypeId),
                          names.purity.get(r.purityId),
                          names.location.get(r.locationId),
                        ]
                          .filter(Boolean)
                          .join(' · ')}
                      </div>
                    </td>
                    <td>
                      <span className={r.trackingMode === 'ITEM' ? 'tag tag-accent' : 'tag tag-accent-2'}>
                        {r.trackingMode === 'ITEM' ? 'UNIQUE' : 'LOT'}
                      </span>
                    </td>
                    <td data-num style={{ fontSize: 12.5 }}>{trio(r.grossMg, r.lessMg)}</td>
                    <td data-num style={{ fontSize: 12.5 }}>
                      {r.balancePieces} pc · {gu(r.balanceNetMg)}
                    </td>
                    <td data-num style={{ fontWeight: 600 }}>
                      {quotes.isLoading ? (
                        <Spin size="small" />
                      ) : !q || !q.hasRate ? (
                        <Tooltip title={t('items.noRateHint')}>
                          <span className="tag tag-outline">No rate — blocked</span>
                        </Tooltip>
                      ) : (
                        rs(q.totalPaisa)
                      )}
                    </td>
                    <td>
                      <span className={STATUS_CLS[r.status] ?? 'tag tag-neutral'}>{r.status}</span>
                    </td>
                    <td style={{ textAlign: 'end', whiteSpace: 'nowrap' }}>
                      {/* Carries the item to the counter. Navigating bare used to
                          land on an empty POS and the shopkeeper had to search
                          for the row they had just clicked. POS adds it through
                          the same path a scan uses, so LOT items and pricing
                          behave identically. Only sellable stock offers it. */}
                      {r.status === 'IN_STOCK' &&
                        (q?.hasRate ? (
                          <button
                            className="btn btn-ghost"
                            style={{ fontSize: 12.5 }}
                            onClick={() => navigate('/pos', { state: { addItemId: r.id } })}
                          >
                            Sell
                          </button>
                        ) : (
                          /* Without a rate the piece cannot be priced, so the
                             cart would only hold a line reading "No rate".
                             Say so here, where the fix is one screen away,
                             rather than after the click. */
                          <Tooltip title={t('items.noRateHint')}>
                            <span
                              className="btn btn-ghost"
                              style={{ fontSize: 12.5, opacity: 0.4, cursor: 'not-allowed' }}
                            >
                              Sell
                            </span>
                          </Tooltip>
                        ))}
                      <button
                        className="btn btn-ghost"
                        style={{ fontSize: 12.5 }}
                        onClick={() => navigate(`/items/${r.id}`)}
                      >
                        Edit
                      </button>
                    </td>
                  </tr>
                );
              })}
              {items.isLoading && (
                <tr>
                  <td colSpan={8} style={{ textAlign: 'center', padding: 24 }}>
                    <Spin />
                  </td>
                </tr>
              )}
              {!items.isLoading && rows.length === 0 && (
                <tr>
                  <td colSpan={8} style={{ opacity: 0.55, padding: 18 }}>
                    {search ? 'Nothing matches that search.' : 'No items yet — add the first one.'}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      <div style={{ display: 'flex', gap: 16, marginTop: 14, fontSize: 11.5, opacity: 0.55, flexWrap: 'wrap' }}>
        <span>
          <span className="tag tag-accent">UNIQUE</span> one tag, fixed weight, sold whole
        </span>
        <span>
          <span className="tag tag-accent-2">LOT</span> sold by entering grams + piece count
        </span>
        {isOwner && <span>Cost and margin are on the item’s own page.</span>}
      </div>
    </Screen>
  );
}
