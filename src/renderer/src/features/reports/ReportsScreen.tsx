import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { App as AntApp, Select, Spin } from 'antd';
import { api } from '../../lib/api.js';
import { Screen } from '../../app/AppShell.js';
import { useSession } from '../../app/session.js';
import { rs0, rs, gu, amount, parseRs } from '../../lib/format.js';

/**
 * The two questions a notebook cannot answer.
 *
 * Every other screen records what the shopkeeper already knows — they were
 * standing there when the sale happened. These two are derived from data only
 * the app keeps: the rate stamped on each invoice against the rate each piece
 * came in at, and how long every piece has sat unsold.
 */

/** Local YYYY-MM-DD; the report's range is a shop-local calendar question. */
function isoDay(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

const RANGES = [
  { key: 'month', label: 'This month' },
  { key: 'last30', label: 'Last 30 days' },
  { key: 'year', label: 'This year' },
] as const;
type RangeKey = (typeof RANGES)[number]['key'];

function rangeDates(key: RangeKey): { fromDate: string; toDate: string } {
  const now = new Date();
  const to = isoDay(now);
  if (key === 'month') {
    return { fromDate: isoDay(new Date(now.getFullYear(), now.getMonth(), 1)), toDate: to };
  }
  if (key === 'year') {
    return { fromDate: isoDay(new Date(now.getFullYear(), 0, 1)), toDate: to };
  }
  const from = new Date(now);
  from.setDate(from.getDate() - 30);
  return { fromDate: isoDay(from), toDate: to };
}

const DEAD_THRESHOLDS = [90, 180, 365] as const;

export function ReportsScreen() {
  const { t } = useTranslation();
  const { session } = useSession();
  const isOwner = session?.role === 'OWNER';

  const [range, setRange] = useState<RangeKey>('month');
  const [threshold, setThreshold] = useState<number>(180);

  const { fromDate, toDate } = rangeDates(range);

  /* Profit exposes cost basis, so the endpoint is owner-only. A manager still
     gets dead stock, which is an operational question rather than a private one. */
  const profit = useQuery({
    queryKey: ['reports', 'profit', fromDate, toDate],
    queryFn: () => api['reports.profit']({ fromDate, toDate }),
    enabled: isOwner,
  });

  const dead = useQuery({
    queryKey: ['reports', 'deadStock', threshold],
    queryFn: () => api['reports.deadStock']({ thresholdDays: threshold, limit: 200 }),
  });

  const p = profit.data;

  return (
    <Screen
      title={t('nav.reports', 'Reports')}
      subtitle="What the books know that the counter cannot see."
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
        {isOwner && (
          <section>
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: 12,
                marginBottom: 10,
                flexWrap: 'wrap',
              }}
            >
              <h4 style={{ margin: 0, fontSize: 17 }}>What you actually made</h4>
              <div className="seg">
                {RANGES.map((r) => (
                  <label key={r.key} className="seg-opt">
                    <input
                      type="radio"
                      name="profit-range"
                      checked={range === r.key}
                      onChange={() => setRange(r.key)}
                    />
                    {r.label}
                  </label>
                ))}
              </div>
            </div>

            {profit.isLoading && <Spin />}

            {p && (
              <>
                {/* The split is the point: a jeweller can add up making charges,
                    but cannot see what the metal itself did while it sat. */}
                <div
                  style={{
                    display: 'grid',
                    gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))',
                    gap: 12,
                    marginBottom: 14,
                  }}
                >
                  <Tile
                    label={p.invoicesMissingCost > 0 ? 'Profit so far' : 'Profit'}
                    value={rs0(p.totalProfitPaisa)}
                    /* Say the figure is partial rather than letting a confident
                       number stand for an incomplete one. */
                    hint={
                      p.invoicesMissingCost > 0
                        ? `${p.invoiceCount} bills · gold movement missing on ${p.invoicesMissingCost}`
                        : `${p.invoiceCount} ${p.invoiceCount === 1 ? 'bill' : 'bills'}`
                    }
                    strong
                  />
                  <Tile
                    label="You earned"
                    value={rs0(p.earnedPaisa)}
                    hint="making, wastage, stones"
                  />
                  <Tile
                    label="The gold did"
                    value={p.invoicesMissingCost === p.invoiceCount && p.invoiceCount > 0 ? '—' : rs0(p.metalGainPaisa)}
                    hint={
                      p.invoicesMissingCost === p.invoiceCount && p.invoiceCount > 0
                        ? 'no purchase rates recorded yet'
                        : p.metalGainPaisa >= 0
                          ? 'rate rose while in stock'
                          : 'rate fell while in stock'
                    }
                  />
                  <Tile label="Sold" value={rs0(p.revenuePaisa)} hint="total billed" />
                </div>

                {p.invoicesMissingCost > 0 && <FixCostPanel invoiceCount={p.invoiceCount} missing={p.invoicesMissingCost} />}

                <div style={{ overflowX: 'auto' }}>
                  <table className="table jp-num">
                    <thead>
                      <tr>
                        <th>Bill</th>
                        <th>Date</th>
                        <th>Customer</th>
                        <th style={{ textAlign: 'end' }}>Sold for</th>
                        <th style={{ textAlign: 'end' }}>You earned</th>
                        <th style={{ textAlign: 'end' }}>Gold moved</th>
                        <th style={{ textAlign: 'end' }}>Profit</th>
                      </tr>
                    </thead>
                    <tbody>
                      {p.rows.map((r) => (
                        <tr key={r.invoiceId}>
                          <td>{r.docNumber ?? r.invoiceId}</td>
                          <td style={{ fontSize: 11.5, opacity: 0.6 }}>{r.docDate.slice(0, 10)}</td>
                          <td style={{ fontSize: 12.5 }}>{r.partyName ?? '—'}</td>
                          <td style={{ textAlign: 'end' }}>{rs(r.grandTotalPaisa)}</td>
                          <td style={{ textAlign: 'end' }}>{rs(r.earnedPaisa)}</td>
                          <td style={{ textAlign: 'end' }}>
                            {r.metalGainPaisa == null ? (
                              <span style={{ opacity: 0.45, fontSize: 12 }}>no cost</span>
                            ) : (
                              rs(r.metalGainPaisa)
                            )}
                          </td>
                          <td style={{ textAlign: 'end', fontWeight: 600 }}>
                            {r.totalProfitPaisa == null ? (
                              <span style={{ opacity: 0.45, fontSize: 12 }}>—</span>
                            ) : (
                              rs(r.totalProfitPaisa)
                            )}
                          </td>
                        </tr>
                      ))}
                      {p.rows.length === 0 && (
                        <tr>
                          <td colSpan={7} style={{ opacity: 0.55, padding: 16 }}>
                            No sales in this period.
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </>
            )}
          </section>
        )}

        <section>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: 12,
              marginBottom: 10,
              flexWrap: 'wrap',
            }}
          >
            <h4 style={{ margin: 0, fontSize: 17 }}>Money asleep on the shelf</h4>
            <div className="seg">
              {DEAD_THRESHOLDS.map((d) => (
                <label key={d} className="seg-opt">
                  <input
                    type="radio"
                    name="dead-threshold"
                    checked={threshold === d}
                    onChange={() => setThreshold(d)}
                  />
                  {d >= 365 ? '1 year+' : `${d} days+`}
                </label>
              ))}
            </div>
          </div>

          {dead.isLoading && <Spin />}

          {dead.data && (
            <>
              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))',
                  gap: 12,
                  marginBottom: 14,
                }}
              >
                <Tile
                  label="Locked up"
                  value={rs0(dead.data.totalLockedPaisa)}
                  hint="at today’s rate"
                  strong
                />
                <Tile
                  label="Pieces"
                  value={String(dead.data.itemCount)}
                  hint={`unsold ${threshold}+ days`}
                />
              </div>

              <div style={{ overflowX: 'auto' }}>
                <table className="table jp-num">
                  <thead>
                    <tr>
                      <th>Tag</th>
                      <th>Piece</th>
                      <th>Type</th>
                      <th>Purity</th>
                      <th style={{ textAlign: 'end' }}>Weight</th>
                      <th style={{ textAlign: 'end' }}>Resting</th>
                      <th style={{ textAlign: 'end' }}>Worth</th>
                    </tr>
                  </thead>
                  <tbody>
                    {dead.data.rows.map((r) => (
                      <tr key={r.itemId}>
                        <td>{r.tagNumber ?? '—'}</td>
                        <td style={{ fontSize: 12.5 }}>{r.name}</td>
                        <td style={{ fontSize: 12.5, opacity: 0.7 }}>{r.productType}</td>
                        <td style={{ fontSize: 12.5, opacity: 0.7 }}>{r.purityLabel}</td>
                        <td style={{ textAlign: 'end' }}>{gu(r.netMg)}</td>
                        <td style={{ textAlign: 'end' }}>
                          {r.daysResting >= 365
                            ? `${(r.daysResting / 365).toFixed(1)} yr`
                            : `${r.daysResting} d`}
                        </td>
                        <td style={{ textAlign: 'end', fontWeight: 600 }}>
                          Rs {amount(r.lockedValuePaisa)}
                        </td>
                      </tr>
                    ))}
                    {dead.data.rows.length === 0 && (
                      <tr>
                        <td colSpan={7} style={{ opacity: 0.55, padding: 16 }}>
                          Nothing has been sitting this long. Your stock is turning over.
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </section>
      </div>
    </Screen>
  );
}


/**
 * The fix for "gold movement unknown", offered where the problem is stated.
 *
 * Every shop that imported a catalogue starts with no purchase rates at all, so
 * the profit report's headline feature is blank on day one. Naming the problem
 * and leaving the owner to edit four hundred items one at a time is the same as
 * not offering the feature — nobody finishes that. One rate per purity is an
 * estimate, and the panel says so, but an approximate cost basis makes the
 * figure roughly right where no basis leaves it blank forever.
 */
function FixCostPanel({ invoiceCount, missing }: { invoiceCount: number; missing: number }) {
  const qc = useQueryClient();
  const { message } = AntApp.useApp();
  const [open, setOpen] = useState(false);
  const [purityId, setPurityId] = useState<number | undefined>();
  const [rate, setRate] = useState('');

  const gaps = useQuery({
    queryKey: ['reports', 'missingCost'],
    queryFn: () => api['reports.missingCost']({ limit: 500 }),
    enabled: open,
  });

  /* Group by purity: the owner backfills a purity at a time, and seeing "312
     pieces" beside 22K is what makes the scale of the gap concrete. */
  const byPurity = useMemo(() => {
    const m = new Map<number, { purityId: number; label: string; count: number }>();
    for (const r of gaps.data ?? []) {
      const cur = m.get(r.purityId);
      if (cur) cur.count++;
      else m.set(r.purityId, { purityId: r.purityId, label: r.purityLabel, count: 1 });
    }
    return [...m.values()].sort((a, b) => b.count - a.count);
  }, [gaps.data]);

  const backfill = useMutation({
    mutationFn: () =>
      api['reports.backfillIntakeRate']({
        purityId: purityId!,
        ratePaisaPerGram: parseRs(rate),
      }),
    onSuccess: (res) => {
      void qc.invalidateQueries({ queryKey: ['reports'] });
      void qc.invalidateQueries({ queryKey: ['items'] });
      message.success(
        `Purchase rate recorded on ${res.pieces} ${res.pieces === 1 ? 'piece' : 'pieces'}.`,
      );
      setRate('');
      setPurityId(undefined);
    },
    onError: (e: Error) => message.error(e.message),
  });

  const selected = byPurity.find((b) => b.purityId === purityId);

  return (
    <div
      style={{
        background: 'var(--color-surface)',
        borderRadius: 16,
        padding: '13px 15px',
        fontSize: 12.5,
        lineHeight: 1.5,
        marginBottom: 14,
      }}
    >
      <div style={{ marginBottom: open ? 12 : 0 }}>
        {missing} of these {invoiceCount} bills have no purchase rate on the piece sold, so what the
        gold did is unknown and is left out rather than guessed.{' '}
        {!open && (
          <button
            className="btn btn-ghost"
            style={{ padding: '2px 8px', fontSize: 12.5 }}
            onClick={() => setOpen(true)}
          >
            Fix this
          </button>
        )}
      </div>

      {open && (
        <>
          <div style={{ opacity: 0.7, marginBottom: 10 }}>
            Give the rate you were paying around the time you bought this stock. It is an estimate —
            an approximate cost makes the gold figure roughly right, where none leaves it blank. A
            rate you typed on an item by hand is never overwritten.
          </div>

          {gaps.isLoading && <Spin size="small" />}

          {byPurity.length > 0 && (
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
              <Select
                placeholder="Which purity?"
                style={{ minWidth: 220 }}
                value={purityId}
                onChange={setPurityId}
                options={byPurity.map((b) => ({
                  value: b.purityId,
                  label: `${b.label} — ${b.count} ${b.count === 1 ? 'piece' : 'pieces'}`,
                }))}
              />
              <input
                className="input jp-num"
                style={{ width: 170 }}
                value={rate}
                onChange={(e) => setRate(e.target.value)}
                placeholder="Rate paid per gram"
              />
              <button
                className="btn btn-primary"
                disabled={backfill.isPending || !purityId || !parseRs(rate)}
                onClick={() => backfill.mutate()}
              >
                {backfill.isPending
                  ? 'Saving…'
                  : selected
                    ? `Apply to ${selected.count}`
                    : 'Apply'}
              </button>
              <button className="btn" onClick={() => setOpen(false)}>
                Close
              </button>
            </div>
          )}

          {!gaps.isLoading && byPurity.length === 0 && (
            <div style={{ opacity: 0.6 }}>
              Every piece still in the catalogue has a purchase rate. The bills above were sold
              before one was recorded.
            </div>
          )}
        </>
      )}
    </div>
  );
}

function Tile({
  label,
  value,
  hint,
  strong = false,
}: {
  label: string;
  value: string;
  hint?: string;
  strong?: boolean;
}) {
  return (
    <div
      style={{
        background: 'var(--color-surface)',
        borderRadius: 22,
        padding: '15px 17px',
      }}
    >
      <div className="jp-kicker" style={{ marginBottom: 6 }}>
        {label}
      </div>
      <div className="jp-num" style={{ fontSize: strong ? 25 : 20, fontWeight: 600 }}>
        {value}
      </div>
      {hint && <div style={{ fontSize: 11.5, opacity: 0.55, marginTop: 3 }}>{hint}</div>}
    </div>
  );
}
