import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Spin } from 'antd';
import { api } from '../../lib/api.js';
import { Screen } from '../../app/AppShell.js';
import { Receipt } from '../pos/Receipt.js';
import { ReturnModal } from './ReturnModal.js';
import { rs, rs0, stamp } from '../../lib/format.js';
import type { z } from 'zod';
import type { InvoiceListRowDTO } from '../../../../shared/contracts/index.js';

type Row = z.infer<typeof InvoiceListRowDTO>;

/** Local YYYY-MM-DD. `toISOString()` would shift the day backwards for any shop
 * east of UTC — which is every shop this app is for (PKT is UTC+5). */
function isoDay(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(
    d.getDate(),
  ).padStart(2, '0')}`;
}

function daysAgo(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return isoDay(d);
}

type Preset = 'today' | 'week' | 'month' | 'all';

const PRESETS: { key: Preset; labelKey: string; from: () => string | null }[] = [
  { key: 'today', labelKey: 'sales.today', from: () => isoDay(new Date()) },
  { key: 'week', labelKey: 'sales.week', from: () => daysAgo(7) },
  { key: 'month', labelKey: 'sales.month', from: () => daysAgo(30) },
  { key: 'all', labelKey: 'sales.all', from: () => null },
];

/** The sales register. Every finalised invoice, newest first — the screen that
 * answers "what did we sell today?" and "what did this customer buy?". It is
 * read-only by design: a finalised invoice is immutable, so this lists and
 * reopens bills, never edits them. */
export function SalesScreen() {
  const { t } = useTranslation();
  const [preset, setPreset] = useState<Preset>('week');
  const [search, setSearch] = useState('');
  const [openId, setOpenId] = useState<number | null>(null);
  // The bill a return is being taken against, if any.
  const [returning, setReturning] = useState<Row | null>(null);
  const qc = useQueryClient();

  const fromDate = useMemo(() => PRESETS.find((p) => p.key === preset)?.from() ?? null, [preset]);

  const invoices = useQuery({
    queryKey: ['sales', 'list', fromDate, search],
    queryFn: () => api['sales.list']({ fromDate, search: search.trim() || null, limit: 300 }),
  });

  const rows: Row[] = invoices.data ?? [];

  // Summed over the rows actually shown, so the figure always matches the list
  // on screen. Cancelled bills are excluded from the money but still listed —
  // the register should show that they happened.
  const summary = useMemo(() => {
    const live = rows.filter((r) => r.status === 'FINAL');
    return {
      count: live.length,
      total: live.reduce((s, r) => s + r.grandTotalPaisa, 0),
      cancelled: rows.length - live.length,
    };
  }, [rows]);

  return (
    <Screen
      title={t('nav.sales')}
      subtitle={t('sales.subtitle')}
      actions={
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <div className="seg">
            {PRESETS.map((p) => (
              <label key={p.key} className="seg-opt">
                <input
                  type="radio"
                  name="salespreset"
                  checked={preset === p.key}
                  onChange={() => setPreset(p.key)}
                />
                {t(p.labelKey)}
              </label>
            ))}
          </div>
          <input
            className="input"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t('sales.searchPh')}
            style={{ width: 250 }}
          />
        </div>
      }
    >
      {/* Takings across the shown range. */}
      <div
        style={{
          display: 'flex',
          gap: 30,
          alignItems: 'baseline',
          background: 'var(--color-surface)',
          borderRadius: 20,
          padding: '14px 20px',
          marginBottom: 14,
          flexWrap: 'wrap',
        }}
      >
        <div>
          <div className="jp-kicker">{t('sales.takings')}</div>
          <div className="jp-figure" style={{ fontSize: 24 }}>
            {rs0(summary.total)}
          </div>
        </div>
        <div>
          <div className="jp-kicker">{t('sales.billCount')}</div>
          <div className="jp-figure" style={{ fontSize: 24 }}>
            {summary.count}
          </div>
        </div>
        {summary.cancelled > 0 && (
          <div>
            <div className="jp-kicker">{t('sales.cancelled')}</div>
            <div className="jp-figure" style={{ fontSize: 24 }}>
              {summary.cancelled}
            </div>
          </div>
        )}
        <div style={{ marginInlineStart: 'auto', fontSize: 11.5, opacity: 0.55, maxWidth: 300 }}>
          {t('sales.readOnlyNote')}
        </div>
      </div>

      <div style={{ background: 'var(--color-surface)', borderRadius: 24, padding: '8px 18px 14px' }}>
        {invoices.isLoading ? (
          <div style={{ display: 'grid', placeItems: 'center', padding: 50 }}>
            <Spin />
          </div>
        ) : rows.length === 0 ? (
          <div style={{ padding: '34px 22px', textAlign: 'center', opacity: 0.55, fontSize: 13 }}>
            {search.trim() ? t('sales.noneMatch') : t('sales.noneYet')}
          </div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table className="table jp-num">
              <thead>
                <tr>
                  <th>{t('sales.col.number')}</th>
                  <th>{t('sales.col.date')}</th>
                  <th>{t('sales.col.customer')}</th>
                  <th>{t('sales.col.items')}</th>
                  <th>{t('sales.col.cashier')}</th>
                  <th>{t('sales.col.total')}</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const cancelled = r.status === 'CANCELLED';
                  return (
                    <tr key={r.id}>
                      <td style={{ fontWeight: 600 }}>
                        {r.docNumber ?? '—'}
                        {cancelled && (
                          <span
                            className="tag tag-accent"
                            style={{ marginInlineStart: 8, fontSize: 10.5 }}
                          >
                            {t('sales.cancelledTag')}
                          </span>
                        )}
                      </td>
                      <td style={{ fontSize: 12, opacity: 0.7 }}>{stamp(r.docDate)}</td>
                      <td>
                        {r.customerName ?? <span style={{ opacity: 0.4 }}>{t('sales.walkIn')}</span>}
                      </td>
                      <td style={{ opacity: 0.7 }}>{r.lineCount}</td>
                      <td style={{ fontSize: 12, opacity: 0.7 }}>{r.cashierName ?? '—'}</td>
                      <td
                        style={{
                          fontWeight: 600,
                          opacity: cancelled ? 0.45 : 1,
                          textDecoration: cancelled ? 'line-through' : undefined,
                        }}
                      >
                        {rs(r.grandTotalPaisa)}
                      </td>
                      <td style={{ whiteSpace: 'nowrap' }}>
                        <button className="btn btn-ghost" onClick={() => setOpenId(r.id)}>
                          {t('sales.openReceipt')}
                        </button>
                        {!cancelled && (
                          <button className="btn btn-ghost" onClick={() => setReturning(r)}>
                            {t('sales.return')}
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <Receipt invoiceId={openId} open={openId != null} onClose={() => setOpenId(null)} />
      <ReturnModal
        invoiceId={returning?.id ?? null}
        docNumber={returning?.docNumber ?? null}
        open={returning != null}
        onClose={() => setReturning(null)}
        onDone={() => void qc.invalidateQueries({ queryKey: ['sales', 'list'] })}
      />
    </Screen>
  );
}
