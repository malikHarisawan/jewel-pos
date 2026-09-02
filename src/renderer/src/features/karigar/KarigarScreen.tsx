import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { Spin, Tooltip } from 'antd';
import { api } from '../../lib/api.js';
import { useSession } from '../../app/session.js';
import { Screen } from '../../app/AppShell.js';
import { IssueJobModal } from './IssueJobModal.js';
import { ReceiveJobModal } from './ReceiveJobModal.js';
import { RawIntakeModal } from './RawIntakeModal.js';
import { g, gu, tola, stamp } from '../../lib/format.js';
import { TOLA_MG } from '../../../../shared/units/index.js';
import type { z } from 'zod';
import type { KarigarJobDTO, KarigarAccountDTO } from '../../../../shared/contracts/index.js';

type Job = z.infer<typeof KarigarJobDTO>;
type Account = z.infer<typeof KarigarAccountDTO>;

/** Metal issued out to goldsmiths and finished pieces received back, with the
 * wastage on the way in checked against the tolerance agreed at issue time. */
export function KarigarScreen() {
  const { t } = useTranslation();
  const { session } = useSession();
  const canWrite = session?.role === 'OWNER' || session?.role === 'MANAGER';
  const [issueOpen, setIssueOpen] = useState(false);
  const [rawOpen, setRawOpen] = useState(false);
  const [receiveJob, setReceiveJob] = useState<Job | null>(null);

  const accounts = useQuery({
    queryKey: ['karigar', 'accounts'],
    queryFn: () => api['karigar.accounts']({}),
  });
  const rawBalances = useQuery({
    queryKey: ['karigar', 'rawBalances'],
    queryFn: () => api['karigar.rawBalances']({}),
  });
  const jobs = useQuery({
    queryKey: ['karigar', 'jobs'],
    queryFn: () => api['karigar.jobs']({ limit: 500 }),
  });
  const settings = useQuery({ queryKey: ['settings'], queryFn: () => api['settings.get']({}) });
  const tolaMg = Number(settings.data?.tola_mg) || TOLA_MG;

  const held = (accounts.data ?? []).filter((a: Account) => a.jobCount > 0);
  const raw = (rawBalances.data ?? []).filter((r) => r.netMg > 0);

  return (
    <Screen
      title={t('nav.karigar')}
      subtitle="Metal issued out of the melt pool, finished pieces received back in — wastage checked against the agreed tolerance on the way in."
      actions={
        canWrite && (
          <>
            <button className="btn btn-secondary" onClick={() => setRawOpen(true)}>
              {t('karigar.buyRawBtn')}
            </button>
            <button className="btn btn-primary" onClick={() => setIssueOpen(true)}>
              {t('karigar.issueBtn')}
            </button>
          </>
        )
      }
    >
      {/* Raw metal on hand — the pool that can be issued. */}
      {raw.length > 0 && (
        <div className="jp-panel" style={{ marginBottom: 14 }}>
          <div className="jp-kicker" style={{ marginBottom: 8 }}>
            {t('karigar.rawOnHand')}
          </div>
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
            {raw.map((r) => (
              <span key={r.purityId} className="tag tag-accent-2 jp-num">
                {r.metalName} {r.purityLabel} · {gu(r.netMg)}
              </span>
            ))}
          </div>
        </div>
      )}

      {/* One card per karigar holding metal. */}
      {held.length > 0 && (
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))',
            gap: 12,
            marginBottom: 14,
          }}
        >
          {held.map((a: Account) => (
            <div
              key={a.karigarPartyId}
              style={{ background: 'var(--color-surface)', borderRadius: 22, padding: '15px 17px' }}
            >
              <div
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'baseline',
                  gap: 10,
                }}
              >
                <span
                  style={{
                    fontFamily: 'var(--font-heading)',
                    fontSize: 18,
                    whiteSpace: 'nowrap',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                  }}
                >
                  {a.karigarName}
                </span>
                {a.overToleranceJobs > 0 && (
                  <span className="tag tag-accent" style={{ flex: 'none' }}>
                    {a.overToleranceJobs} {t('karigar.flagged')}
                  </span>
                )}
              </div>
              <div className="jp-num" style={{ fontSize: 11.5, opacity: 0.6, marginBottom: 8 }}>
                {a.jobCount} job{a.jobCount === 1 ? '' : 's'}
              </div>
              <div
                style={{
                  fontSize: 9.5,
                  letterSpacing: '.1em',
                  textTransform: 'uppercase',
                  opacity: 0.5,
                }}
              >
                Raw metal with him
              </div>
              <div className="jp-num" style={{ fontFamily: 'var(--font-heading)', fontSize: 20 }}>
                {gu(a.holdingMg)}
              </div>
              <div className="jp-num" style={{ fontSize: 11.5, opacity: 0.55 }}>
                {tola(a.holdingMg, tolaMg)} tola
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Jobs */}
      <div style={{ background: 'var(--color-surface)', borderRadius: 24, padding: '14px 18px' }}>
        <h4 style={{ margin: '0 0 8px', fontSize: 17 }}>{t('karigar.jobsTitle')}</h4>
        <div style={{ overflowX: 'auto' }}>
          <table className="table jp-num">
            <thead>
              <tr>
                <th>{t('karigar.col.job')}</th>
                <th>{t('karigar.col.karigar')}</th>
                <th>{t('items.field.purity')}</th>
                <th>{t('karigar.col.issued')}</th>
                <th>{t('karigar.col.received')}</th>
                <th style={{ minWidth: 170 }}>{t('karigar.col.wastage')}</th>
                <th>{t('karigar.col.status')}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {(jobs.data ?? []).map((j: Job) => {
                const allowedPct = j.allowedWastageBp / 100;
                const actualPct =
                  j.actualWastageMg != null && j.issuedNetMg
                    ? (j.actualWastageMg / j.issuedNetMg) * 100
                    : null;
                // The bar fills to the tolerance line at 71%, so anything past
                // that marker is visibly over budget.
                const barPct =
                  actualPct != null
                    ? Math.min(Math.round((actualPct / Math.max(allowedPct, 0.1)) * 71), 140)
                    : 0;
                return (
                  <tr key={j.id} className={j.overTolerance ? 'jp-row-flagged' : undefined}>
                    <td>
                      <div style={{ fontWeight: 600 }}>{j.jobNumber}</div>
                      <div style={{ fontSize: 10.5, opacity: 0.5 }}>{stamp(j.issuedAt)}</div>
                    </td>
                    <td style={{ fontSize: 12.5 }}>{j.karigarName}</td>
                    <td>{j.purityLabel}</td>
                    <td>{gu(j.issuedNetMg)}</td>
                    <td style={{ fontSize: 12 }}>
                      {j.receivedNetMg != null ? gu(j.receivedNetMg) : 'awaiting'}
                    </td>
                    <td>
                      {actualPct == null ? (
                        <span style={{ opacity: 0.5 }}>—</span>
                      ) : (
                        <>
                          <div style={{ fontSize: 12, marginBottom: 4 }}>
                            {g(j.actualWastageMg!)} g · {actualPct.toFixed(2)}%{' '}
                            <span style={{ opacity: 0.5 }}>· tol {allowedPct}%</span>
                          </div>
                          <div
                            style={{
                              height: 7,
                              borderRadius: 999,
                              background: 'color-mix(in srgb, var(--color-text) 8%, transparent)',
                              position: 'relative',
                            }}
                          >
                            {/* the agreed tolerance, as a fixed marker */}
                            <div
                              style={{
                                position: 'absolute',
                                insetInlineStart: '71%',
                                top: -2,
                                bottom: -2,
                                width: 1.5,
                                background: 'color-mix(in srgb, var(--color-text) 45%, transparent)',
                              }}
                            />
                            <div
                              style={{
                                height: '100%',
                                borderRadius: 999,
                                background: j.overTolerance
                                  ? 'var(--color-accent)'
                                  : 'var(--color-accent-2-500)',
                                width: `${Math.min(barPct, 100)}%`,
                              }}
                            />
                          </div>
                        </>
                      )}
                    </td>
                    <td>
                      {j.overTolerance ? (
                        <Tooltip
                          title={`${t('karigar.overBy')} — ${t('karigar.allowed')} ${allowedPct}%`}
                        >
                          <span className="tag tag-accent">{t('karigar.over')}</span>
                        </Tooltip>
                      ) : (
                        <span
                          className={j.status === 'OPEN' ? 'tag tag-neutral' : 'tag tag-accent-2'}
                        >
                          {j.status}
                        </span>
                      )}
                    </td>
                    <td style={{ textAlign: 'end' }}>
                      {canWrite && j.status === 'OPEN' && (
                        <button
                          className="btn btn-ghost"
                          style={{ fontSize: 12 }}
                          onClick={() => setReceiveJob(j)}
                        >
                          {t('karigar.receiveBtn')}
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
              {jobs.isLoading && (
                <tr>
                  <td colSpan={8} style={{ textAlign: 'center', padding: 20 }}>
                    <Spin />
                  </td>
                </tr>
              )}
              {!jobs.isLoading && (jobs.data ?? []).length === 0 && (
                <tr>
                  <td colSpan={8} style={{ opacity: 0.55, padding: 16 }}>
                    No jobs yet — issue metal to open one.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      <RawIntakeModal open={rawOpen} onClose={() => setRawOpen(false)} />
      <IssueJobModal open={issueOpen} onClose={() => setIssueOpen(false)} />
      <ReceiveJobModal
        job={receiveJob}
        open={receiveJob != null}
        onClose={() => setReceiveJob(null)}
      />
    </Screen>
  );
}
