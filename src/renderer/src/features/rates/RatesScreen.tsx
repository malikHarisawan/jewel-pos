import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { App as AntApp, Select, Spin } from 'antd';
import { api } from '../../lib/api.js';
import { useCatalog } from '../items/useCatalog.js';
import { useSession } from '../../app/session.js';
import { Screen } from '../../app/AppShell.js';
import { amount, stamp, parseRs } from '../../lib/format.js';
import {
  normalizeRateToPaisaPerGram,
  TOLA_MG,
  MG_PER_GRAM,
  type RateBasis,
} from '../../../../shared/units/index.js';
import type { z } from 'zod';
import type { LatestRateDTO, RateDTO } from '../../../../shared/contracts/index.js';

type LatestRate = z.infer<typeof LatestRateDTO>;
type Rate = z.infer<typeof RateDTO>;

const BASIS_LABEL: Record<string, string> = {
  PER_GRAM: 'per gram',
  PER_TOLA: 'per tola',
  PER_10G: 'per 10 g',
};

/** Today's metal rates. Entered in whatever unit the bazaar quotes and stored
 * as paisa per gram; the history is append-only, so a mistake is corrected by
 * posting again rather than editing. */
export function RatesScreen() {
  const { t } = useTranslation();
  const { session } = useSession();
  const canWrite = session?.role === 'OWNER' || session?.role === 'MANAGER';
  const qc = useQueryClient();
  const { message } = AntApp.useApp();
  const catalog = useCatalog();

  const [historyPurity, setHistoryPurity] = useState<number | undefined>();
  const [purityId, setPurityId] = useState<number | undefined>();
  const [basis, setBasis] = useState<RateBasis>('PER_TOLA');
  const [value, setValue] = useState('');

  const latest = useQuery({ queryKey: ['rates', 'latest'], queryFn: () => api['rates.latest']({}) });
  const history = useQuery({
    queryKey: ['rates', 'history', historyPurity],
    queryFn: () => api['rates.history']({ purityId: historyPurity, limit: 100 }),
  });
  const settings = useQuery({ queryKey: ['settings'], queryFn: () => api['settings.get']({}) });

  const tolaMg = Number(settings.data?.tola_mg) || TOLA_MG;
  const perTola = (perGram: number) => Math.round((perGram * tolaMg) / MG_PER_GRAM);

  const metalName = useMemo(() => {
    const m = new Map<number, string>();
    catalog.data?.metals.forEach((x) => m.set(x.id, x.name));
    return m;
  }, [catalog.data]);

  const enter = useMutation({
    mutationFn: () =>
      api['rates.enter']({
        purityId: purityId!,
        enteredValuePaisa: parseRs(value),
        enteredBasis: basis,
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['rates'] });
      // Every price on screen is derived from a rate, so the shelf re-prices.
      void qc.invalidateQueries({ queryKey: ['items'] });
      void qc.invalidateQueries({ queryKey: ['dashboard'] });
      message.success(t('rates.entered'));
      setValue('');
    },
    onError: (e: Error) => message.error(e.message),
  });

  const submit = () => {
    if (!purityId) return message.error('Pick a purity.');
    if (!parseRs(value)) return message.error('Enter the rate amount.');
    enter.mutate();
  };

  // Live normalisation preview — the same conversion the server will apply.
  const entered = parseRs(value);
  const normalised = entered ? normalizeRateToPaisaPerGram(entered, basis, tolaMg) : 0;
  const preview = normalised
    ? `Rs ${amount(normalised)} per gram  ·  Rs ${amount(perTola(normalised))} per tola  ·  Rs ${amount(normalised * 10)} per 10 g`
    : 'Enter an amount to see the normalised rate';

  const rows = latest.data ?? [];

  return (
    <Screen
      title={t('nav.rates')}
      subtitle="Entered in whatever unit the bazaar quotes; stored as paisa per gram. History is append-only — a mistake is corrected by posting again."
    >
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: canWrite ? 'minmax(0, 1fr) 380px' : 'minmax(0, 1fr)',
          gap: 16,
          alignItems: 'start',
        }}
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          {/* Rate board — one card per purity, blocked ones called out. */}
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))',
              gap: 12,
            }}
          >
            {rows.map((r: LatestRate) => {
              const live = r.ratePaisaPerGram != null;
              return (
                <div
                  key={r.purityId}
                  style={{ background: 'var(--color-surface)', borderRadius: 22, padding: '15px 17px' }}
                >
                  <div
                    style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'center',
                      marginBottom: 8,
                      gap: 8,
                    }}
                  >
                    <span style={{ fontFamily: 'var(--font-heading)', fontSize: 19 }}>{r.label}</span>
                    <span className={live ? 'tag tag-accent-2' : 'tag tag-outline'}>
                      {live ? 'live' : 'blocked'}
                    </span>
                  </div>
                  <div className="jp-num" style={{ fontSize: 19, fontWeight: 600 }}>
                    {live ? `Rs ${amount(perTola(r.ratePaisaPerGram!))}` : '— no rate —'}
                  </div>
                  <div className="jp-num" style={{ fontSize: 12, opacity: 0.6 }}>
                    {live
                      ? `per tola · Rs ${amount(r.ratePaisaPerGram!)} per gram`
                      : 'pricing blocked in this purity'}
                  </div>
                  <div style={{ fontSize: 11, opacity: 0.45, marginTop: 6 }}>
                    {live ? stamp(r.effectiveAt) : 'not entered today'}
                  </div>
                </div>
              );
            })}
            {latest.isLoading && <Spin />}
          </div>

          {/* History */}
          <div style={{ background: 'var(--color-surface)', borderRadius: 24, padding: '14px 18px' }}>
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
              <h4 style={{ margin: 0, fontSize: 17 }}>{t('rates.historyTitle')}</h4>
              <Select
                allowClear
                placeholder={t('rates.allPurities')}
                style={{ width: 220 }}
                value={historyPurity}
                onChange={setHistoryPurity}
                options={rows.map((r) => ({
                  value: r.purityId,
                  label: `${metalName.get(r.metalId) ?? ''} · ${r.label}`,
                }))}
              />
            </div>
            <div style={{ overflowX: 'auto' }}>
              <table className="table jp-num">
                <thead>
                  <tr>
                    <th>{t('rates.col.when')}</th>
                    <th>Purity</th>
                    <th>{t('rates.col.entered')}</th>
                    <th>{t('rates.col.perGram')}</th>
                    <th>Per tola</th>
                    <th>{t('rates.col.by')}</th>
                  </tr>
                </thead>
                <tbody>
                  {(history.data ?? []).map((r: Rate) => {
                    const label = rows.find((x) => x.purityId === r.purityId)?.label ?? r.purityId;
                    return (
                      <tr key={r.id}>
                        <td style={{ fontSize: 11.5, opacity: 0.6 }}>{stamp(r.effectiveAt)}</td>
                        <td>{label}</td>
                        <td style={{ fontSize: 12, opacity: 0.65 }}>
                          Rs {amount(r.enteredValuePaisa)} {BASIS_LABEL[r.enteredBasis]}
                        </td>
                        <td style={{ fontWeight: 600 }}>Rs {amount(r.ratePaisaPerGram)}</td>
                        <td>Rs {amount(perTola(r.ratePaisaPerGram))}</td>
                        <td style={{ fontSize: 11.5, opacity: 0.6 }}>{r.enteredByName}</td>
                      </tr>
                    );
                  })}
                  {history.isLoading && (
                    <tr>
                      <td colSpan={6} style={{ textAlign: 'center', padding: 20 }}>
                        <Spin />
                      </td>
                    </tr>
                  )}
                  {!history.isLoading && (history.data ?? []).length === 0 && (
                    <tr>
                      <td colSpan={6} style={{ opacity: 0.55, padding: 16 }}>
                        No rates posted yet.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>

        {canWrite && (
          <div className="jp-panel">
            <div className="jp-kicker" style={{ marginBottom: 12 }}>
              {t('rates.enterTitle')}
            </div>
            <div className="field" style={{ marginBottom: 12 }}>
              <label>Purity</label>
              <Select
                value={purityId}
                onChange={setPurityId}
                style={{ width: '100%' }}
                placeholder="Choose a purity"
                options={rows.map((r) => ({
                  value: r.purityId,
                  label: `${metalName.get(r.metalId) ?? ''} · ${r.label}`,
                }))}
              />
            </div>

            <label style={{ display: 'block', fontSize: 12, marginBottom: 6, opacity: 0.7 }}>
              Quoted per
            </label>
            <div className="seg" style={{ marginBottom: 12 }}>
              {(
                [
                  ['PER_GRAM', 'gram'],
                  ['PER_TOLA', 'tola'],
                  ['PER_10G', '10 g'],
                ] as [RateBasis, string][]
              ).map(([v, label]) => (
                <label key={v} className="seg-opt">
                  <input
                    type="radio"
                    name="basis"
                    checked={basis === v}
                    onChange={() => setBasis(v)}
                  />
                  {label}
                </label>
              ))}
            </div>

            <div className="field" style={{ marginBottom: 12 }}>
              <label>{t('rates.value')}</label>
              <input
                className="input jp-num"
                value={value}
                onChange={(e) => setValue(e.target.value)}
                placeholder="300,000"
                onKeyDown={(e) => e.key === 'Enter' && submit()}
              />
            </div>

            <div
              style={{
                background: 'var(--color-bg)',
                borderRadius: 18,
                padding: '11px 14px',
                fontSize: 12,
                lineHeight: 1.5,
                marginBottom: 12,
              }}
            >
              <div
                style={{
                  fontSize: 9.5,
                  letterSpacing: '.1em',
                  textTransform: 'uppercase',
                  opacity: 0.5,
                  marginBottom: 3,
                }}
              >
                Normalises to
              </div>
              <span className="jp-num">{preview}</span>
            </div>

            <button className="btn btn-primary btn-block" disabled={enter.isPending} onClick={submit}>
              {t('rates.enterBtn')}
            </button>
            <div style={{ fontSize: 11, opacity: 0.55, marginTop: 10, lineHeight: 1.45 }}>
              Posting does not change any finalised invoice. Items priced before the change keep the
              rate stamped on their invoice.
            </div>
          </div>
        )}
      </div>
    </Screen>
  );
}
