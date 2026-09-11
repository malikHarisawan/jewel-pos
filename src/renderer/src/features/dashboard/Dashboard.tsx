import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router';
import { App as AntApp, Spin } from 'antd';
import { api } from '../../lib/api.js';
import { Screen } from '../../app/AppShell.js';
import { useCatalog } from '../items/useCatalog.js';
import { useSession } from '../../app/session.js';
import { amount, rs, rs0, gu, tola, weekdayDate, stamp, parseRs } from '../../lib/format.js';
import {
  normalizeRateToPaisaPerGram,
  TOLA_MG,
  MG_PER_GRAM,
  type RateBasis,
} from '../../../../shared/units/index.js';
import type { z } from 'zod';
import type { LatestRateDTO, DashboardSummaryOutput } from '../../../../shared/contracts/index.js';

type Summary = z.infer<typeof DashboardSummaryOutput>;
type LatestRate = z.infer<typeof LatestRateDTO>;

/** The counter's opening screen: today's rates, what is on the shelves, and
 * what it is worth at those rates. Everything here is derived — no figure on
 * this screen is stored. */
export function Dashboard() {
  const { t } = useTranslation();
  const navigate = useNavigate();

  const summary = useQuery({
    queryKey: ['dashboard', 'summary'],
    queryFn: () => api['dashboard.summary']({}),
  });
  const rates = useQuery({ queryKey: ['rates', 'latest'], queryFn: () => api['rates.latest']({}) });
  const catalog = useCatalog();
  // Mirrors the `roles` on `rates.enter`: a salesman sees the rates but cannot
  // post them, so the inline editor is not offered rather than failing on save.
  const { session } = useSession();
  const canPostRates = session?.role === 'OWNER' || session?.role === 'MANAGER';
  const settings = useQuery({ queryKey: ['settings'], queryFn: () => api['settings.get']({}) });

  const tolaMg = Number(settings.data?.tola_mg) || TOLA_MG;
  const perTola = (perGram: number) => Math.round((perGram * tolaMg) / MG_PER_GRAM);

  const rateRows = rates.data ?? [];
  const priced = rateRows.filter((r: LatestRate) => r.ratePaisaPerGram != null);

  // The dashboard shows one gold line and one silver line, not the whole purity
  // list. Six rows of "pricing blocked" is noise on the screen the counter looks
  // at all day, and it read as six problems when the shop only ever posts two
  // rates. Every purity is still settable on the Rates screen.
  //
  // A row is kept when it already has a rate — a purity someone deliberately
  // priced must never vanish from view — or when it is the headline purity of
  // gold or silver. Headline means first in catalogue order, which is the
  // shop's main line (22K for gold in the default catalogue). Selecting by
  // metal name rather than id keeps this working on a shop that has edited its
  // own purity list.
  const dashboardRates = useMemo(() => {
    const everyday = new Set(
      (catalog.data?.metals ?? [])
        .filter((m) => m.name === 'Gold' || m.name === 'Silver')
        .map((m) => m.id),
    );
    const firstOfMetal = new Map<number, number>();
    rateRows.forEach((r: LatestRate) => {
      if (!firstOfMetal.has(r.metalId)) firstOfMetal.set(r.metalId, r.purityId);
    });
    return rateRows.filter(
      (r: LatestRate) =>
        r.ratePaisaPerGram != null ||
        (everyday.has(r.metalId) && firstOfMetal.get(r.metalId) === r.purityId),
    );
  }, [rateRows, catalog.data]);

  // The headline rate is the shop's main line — the highest-value gold purity
  // that actually has a rate today.
  const headline = useMemo(
    () =>
      priced
        .slice()
        .sort((a, b) => (b.ratePaisaPerGram ?? 0) - (a.ratePaisaPerGram ?? 0))[0] ?? null,
    [priced],
  );

  const missingShown = dashboardRates.filter((r: LatestRate) => r.ratePaisaPerGram == null);

  const s: Summary | undefined = summary.data;
  const lastPosted = priced
    .map((r) => r.effectiveAt)
    .filter(Boolean)
    .sort()
    .at(-1);

  const kpis = [
    headline
      ? {
          k: `${headline.label} rate today`,
          v: `Rs ${amount(perTola(headline.ratePaisaPerGram!))}`,
          s: `per tola · Rs ${amount(headline.ratePaisaPerGram!)} per gram`,
        }
      : { k: 'Rate today', v: 'No rate', s: 'post a rate before anything can be priced' },
    {
      k: 'Stock on hand',
      v: s ? `${tola(s.totalNetMg, tolaMg)} tola` : '—',
      s: s ? `${gu(s.totalNetMg)} net · ${s.totalPieces} pieces` : '',
    },
    {
      k: 'Stock value at today’s rate',
      v: s ? rs0(s.totalValuePaisa) : '—',
      s: s?.unratedNetMg
        ? `metal only · ${gu(s.unratedNetMg)} unpriced`
        : 'metal only — making and stones excluded',
    },
    {
      k: 'Items in stock',
      v: s ? String(s.totalItems) : '—',
      s: s ? `${s.byCategory.length} categor${s.byCategory.length === 1 ? 'y' : 'ies'}` : '',
    },
  ];

  const maxCatValue = Math.max(1, ...(s?.byCategory ?? []).map((c) => c.valuePaisa));

  return (
    <Screen
      title="Counter today"
      subtitle={
        <>
          {weekdayDate()}
          {lastPosted ? ` · rates posted ${stamp(lastPosted)}` : ' · no rate posted yet'}
        </>
      }
      actions={
        <>
          <button className="btn btn-secondary" onClick={() => navigate('/rates')}>
            Rates · F4
          </button>
          <button className="btn btn-primary" onClick={() => navigate('/pos')}>
            New sale · F5
          </button>
        </>
      }
    >
      {/* A purity with no rate cannot be priced anywhere in the app — say so
          loudly, and put the fix one click away. Scoped to the rows the table
          below shows: naming all six purities here while the table listed two
          told the shopkeeper about four problems they had not chosen to have,
          and buried the one line that actually stops a sale. */}
      {missingShown.length > 0 && (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 12,
            background: 'var(--color-accent-100)',
            border: '1px solid var(--color-accent-300)',
            borderRadius: 18,
            padding: '11px 16px',
            marginBottom: 18,
          }}
        >
          <svg
            width="17"
            height="17"
            viewBox="0 0 24 24"
            fill="none"
            stroke="var(--color-accent-700)"
            strokeWidth="2.75"
            strokeLinecap="round"
            style={{ flex: 'none' }}
          >
            <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3M12 9v4M12 17h.01" />
          </svg>
          <div style={{ fontSize: 13, color: 'var(--color-accent-800)' }}>
            <strong>No rate today for {missingShown.map((r) => r.label).join(', ')}.</strong> Every item in
            those purities is unpriceable until a rate is posted.
          </div>
          <a
            href="#"
            onClick={(e) => {
              e.preventDefault();
              navigate('/rates');
            }}
            style={{ marginInlineStart: 'auto', fontSize: 12.5, whiteSpace: 'nowrap' }}
          >
            Post it on Rates · F4
          </a>
        </div>
      )}

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
          gap: 14,
          marginBottom: 18,
        }}
      >
        {kpis.map((k) => (
          <div
            key={k.k}
            style={{
              background: 'var(--color-surface)',
              borderRadius: 24,
              padding: '16px 18px',
              display: 'flex',
              flexDirection: 'column',
              gap: 6,
              minHeight: 118,
            }}
          >
            <div className="jp-kicker">{k.k}</div>
            <div
              className="jp-figure" style={{ fontSize: 26,
                lineHeight: 1.05,
                wordBreak: 'break-word',
              }}
            >
              {summary.isLoading ? <Spin size="small" /> : k.v}
            </div>
            <div style={{ fontSize: 11.5, opacity: 0.58, marginTop: 'auto', lineHeight: 1.35 }}>
              {k.s}
            </div>
          </div>
        ))}
      </div>

      <div
        style={{
          display: 'grid',
          /* The rates table carries an action column now; 420px squeezed it
             into a horizontal scroll and wrapped the buttons. */
          gridTemplateColumns: 'repeat(auto-fit, minmax(520px, 1fr))',
          gap: 16,
          alignItems: 'start',
        }}
      >
        {/* Rates, in every unit the bazaar quotes. */}
        <div className="jp-panel">
          <div
            style={{
              display: 'flex',
              alignItems: 'baseline',
              justifyContent: 'space-between',
              marginBottom: 12,
              gap: 12,
            }}
          >
            <h4 style={{ margin: 0 }}>Rates per gram &amp; per tola</h4>
            <span style={{ fontSize: 11, opacity: 0.55, whiteSpace: 'nowrap' }}>
              1 tola = {(tolaMg / MG_PER_GRAM).toFixed(3)} g
            </span>
          </div>
          <div style={{ overflowX: 'auto' }}>
            <table className="table jp-num">
              <thead>
                <tr>
                  <th>Purity</th>
                  <th>Per gram</th>
                  <th>Per tola</th>
                  <th>Per 10 g</th>
                  <th>Posted</th>
                  {canPostRates && <th />}
                </tr>
              </thead>
              <tbody>
                {dashboardRates.map((r: LatestRate) => (
                  <RateRow
                    key={r.purityId}
                    r={r}
                    tolaMg={tolaMg}
                    perTola={perTola}
                    canPost={canPostRates}
                  />
                ))}
                {dashboardRates.length === 0 && (
                  <tr>
                    <td colSpan={canPostRates ? 6 : 5} style={{ opacity: 0.55 }}>
                      {t('dash.noRates')}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>

        {/* What is on the shelves. */}
        <div className="jp-panel">
          <h4 style={{ margin: '0 0 12px' }}>Stock by metal</h4>
          <div style={{ overflowX: 'auto' }}>
            <table className="table jp-num">
              <thead>
                <tr>
                  <th>Metal</th>
                  <th>Items</th>
                  <th>Net</th>
                  <th>Tola</th>
                  <th>Metal value</th>
                </tr>
              </thead>
              <tbody>
                {(s?.byMetal ?? []).map((m) => (
                  <tr key={m.metalId}>
                    <td>{m.metalName}</td>
                    <td>{m.items}</td>
                    <td>{gu(m.netMg)}</td>
                    <td style={{ opacity: 0.7 }}>{tola(m.netMg, tolaMg)}</td>
                    <td style={{ fontWeight: 600 }}>{rs(m.valuePaisa)}</td>
                  </tr>
                ))}
                {!summary.isLoading && (s?.byMetal.length ?? 0) === 0 && (
                  <tr>
                    <td colSpan={5} style={{ opacity: 0.55 }}>
                      Nothing in stock yet.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          {(s?.byCategory.length ?? 0) > 0 && (
            <>
              <div
                style={{
                  fontSize: 10,
                  letterSpacing: '.12em',
                  textTransform: 'uppercase',
                  opacity: 0.5,
                  margin: '18px 0 10px',
                }}
              >
                By category
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 9 }}>
                {(s?.byCategory ?? []).map((c) => (
                  <div key={c.productTypeId}>
                    <div
                      className="jp-num"
                      style={{
                        display: 'flex',
                        justifyContent: 'space-between',
                        fontSize: 12,
                        marginBottom: 4,
                        gap: 10,
                      }}
                    >
                      <span>
                        {c.productTypeName}{' '}
                        <span style={{ opacity: 0.5 }}>
                          · {c.items} pc · {gu(c.netMg)}
                        </span>
                      </span>
                      <span style={{ fontWeight: 600, whiteSpace: 'nowrap' }}>{rs(c.valuePaisa)}</span>
                    </div>
                    <div
                      style={{
                        height: 7,
                        borderRadius: 999,
                        background: 'color-mix(in srgb, var(--color-text) 8%, transparent)',
                        overflow: 'hidden',
                      }}
                    >
                      <div
                        style={{
                          height: '100%',
                          borderRadius: 999,
                          background: 'var(--color-accent-400)',
                          width: `${Math.round((c.valuePaisa / maxCatValue) * 100)}%`,
                        }}
                      />
                    </div>
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
      </div>
    </Screen>
  );
}

/** One rate line, with the rate editable in place.
 *
 * The counter posts the day's gold and silver rate before anything can be sold,
 * so making that a trip to another screen taxed the most routine act in the
 * shop. Posting here writes through `rates.enter` — the same append-only path
 * the Rates screen uses — so history and normalisation are identical; this is a
 * shortcut to the action, not a second way of doing it. */
function RateRow({
  r,
  tolaMg,
  perTola,
  canPost,
}: {
  r: LatestRate;
  tolaMg: number;
  perTola: (perGram: number) => number;
  canPost: boolean;
}) {
  const qc = useQueryClient();
  const { message } = AntApp.useApp();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState('');
  // Per tola is how the bazaar quotes gold, and it is the Rates screen's own
  // default, so the shortcut opens on the same basis rather than surprising
  // someone who has learned the long form.
  const [basis, setBasis] = useState<RateBasis>('PER_TOLA');

  const enter = useMutation({
    mutationFn: () =>
      api['rates.enter']({
        purityId: r.purityId,
        enteredValuePaisa: parseRs(value),
        enteredBasis: basis,
      }),
    onSuccess: () => {
      // Every price in the app derives from a rate, so the shelf, the cart and
      // the dashboard's own valuation all have to re-read.
      void qc.invalidateQueries({ queryKey: ['rates'] });
      void qc.invalidateQueries({ queryKey: ['items'] });
      void qc.invalidateQueries({ queryKey: ['dashboard'] });
      message.success(`${r.label} rate posted`);
      setEditing(false);
      setValue('');
    },
    onError: (e: Error) => message.error(e.message),
  });

  const submit = (): void => {
    if (!parseRs(value)) {
      message.error('Enter the rate amount.');
      return;
    }
    enter.mutate();
  };

  // The same conversion the server will apply, shown before committing: the
  // bazaar quotes per tola and the shop thinks per gram, and a rate posted on
  // the wrong basis misprices the whole shelf.
  const entered = parseRs(value);
  const preview = entered ? normalizeRateToPaisaPerGram(entered, basis, tolaMg) : 0;

  if (editing) {
    return (
      <tr>
        <td>
          <span className="tag tag-accent-2">{r.label}</span>
        </td>
        <td colSpan={3}>
          <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
            <input
              className="input jp-num"
              style={{ width: 120 }}
              autoFocus
              inputMode="decimal"
              placeholder="0.00"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') submit();
                if (e.key === 'Escape') setEditing(false);
              }}
            />
            <div className="seg">
              {(
                [
                  ['PER_GRAM', 'gram'],
                  ['PER_TOLA', 'tola'],
                  ['PER_10G', '10 g'],
                ] as [RateBasis, string][]
              ).map(([v, label]) => (
                <label key={v} className="seg-opt">
                  {/* Scoped per purity: a shared radio name would make the rows
                      fight over one selection. */}
                  <input
                    type="radio"
                    name={`basis-${r.purityId}`}
                    checked={basis === v}
                    onChange={() => setBasis(v)}
                  />
                  {label}
                </label>
              ))}
            </div>
            <span style={{ fontSize: 11.5, opacity: 0.6 }}>
              {preview ? `= Rs ${amount(preview)}/g` : 'enter an amount'}
            </span>
          </div>
        </td>
        <td style={{ textAlign: 'end', whiteSpace: 'nowrap' }}>
          <button className="btn btn-primary" style={{ fontSize: 12.5 }} onClick={submit} disabled={enter.isPending}>
            {enter.isPending ? <Spin size="small" /> : 'Save'}
          </button>
          <button className="btn btn-ghost" style={{ fontSize: 12.5 }} onClick={() => setEditing(false)}>
            Cancel
          </button>
        </td>
      </tr>
    );
  }

  return (
    <tr>
      <td>
        <span className={r.ratePaisaPerGram != null ? 'tag tag-accent-2' : 'tag tag-outline'}>
          {r.label}
        </span>
      </td>
      {r.ratePaisaPerGram != null ? (
        <>
          <td style={{ fontWeight: 600 }}>Rs {amount(r.ratePaisaPerGram)}</td>
          <td>Rs {amount(perTola(r.ratePaisaPerGram))}</td>
          <td style={{ opacity: 0.7 }}>Rs {amount(r.ratePaisaPerGram * 10)}</td>
          <td style={{ fontSize: 11.5, opacity: 0.55 }}>{stamp(r.effectiveAt)}</td>
        </>
      ) : (
        <>
          <td style={{ opacity: 0.55 }}>— no rate —</td>
          <td style={{ opacity: 0.55 }}>pricing blocked</td>
          <td style={{ opacity: 0.55 }}>—</td>
          <td style={{ fontSize: 11.5, opacity: 0.55 }}>not entered today</td>
        </>
      )}
      {canPost && (
        <td style={{ textAlign: 'end', whiteSpace: 'nowrap' }}>
          <button
            className="btn btn-ghost"
            style={{ fontSize: 12.5 }}
            onClick={() => {
              // Prefill with the standing rate so a small correction is a small
              // edit, not a retype of the whole figure.
              setValue(r.ratePaisaPerGram != null ? String(perTola(r.ratePaisaPerGram) / 100) : '');
              setBasis('PER_TOLA');
              setEditing(true);
            }}
          >
            {r.ratePaisaPerGram != null ? 'Update' : 'Set rate'}
          </button>
        </td>
      )}
    </tr>
  );
}
