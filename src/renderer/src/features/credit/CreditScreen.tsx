import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { App as AntApp, Modal, Select, Spin } from 'antd';
import { api } from '../../lib/api.js';
import { Screen } from '../../app/AppShell.js';
import { useSession } from '../../app/session.js';
import { rs, rs0, stamp, parseRs } from '../../lib/format.js';
import type { z } from 'zod';
import type { DebtorDTO } from '../../../../shared/contracts/index.js';

type Debtor = z.infer<typeof DebtorDTO>;

const ENTRY_LABEL: Record<string, string> = {
  CREDIT_SALE: 'Sale on credit',
  REPAYMENT: 'Payment received',
  RETURN_CREDIT: 'Return credited',
  OPENING: 'Opening balance',
  ADJUSTMENT: 'Adjustment',
};

/** Udhaar — who owes the shop, and what they have paid so far.
 *
 * Balances are folded from an append-only ledger, so every figure here can be
 * explained by the rows beneath it. Nothing on this screen edits history: a
 * payment is a new entry, never a correction of an old one. */
export function CreditScreen() {
  const { t } = useTranslation();
  const { session } = useSession();
  const canTakeMoney = session?.role === 'OWNER' || session?.role === 'MANAGER';

  const [openParty, setOpenParty] = useState<Debtor | null>(null);
  const [showSettled, setShowSettled] = useState(false);

  const debtors = useQuery({
    queryKey: ['credit', 'debtors', showSettled],
    queryFn: () => api['credit.debtors']({ includeSettled: showSettled }),
  });

  const rows: Debtor[] = debtors.data ?? [];
  const outstanding = rows.reduce((s, d) => s + Math.max(d.balancePaisa, 0), 0);

  return (
    <Screen
      title={t('nav.credit')}
      subtitle={t('credit.subtitle')}
      actions={
        <label style={{ display: 'flex', gap: 7, alignItems: 'center', fontSize: 12.5 }}>
          <input
            type="checkbox"
            checked={showSettled}
            onChange={(e) => setShowSettled(e.target.checked)}
          />
          {t('credit.showSettled')}
        </label>
      }
    >
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
          <div className="jp-kicker">{t('credit.totalOut')}</div>
          <div className="jp-num" style={{ fontFamily: 'var(--font-heading)', fontSize: 24 }}>
            {rs0(outstanding)}
          </div>
        </div>
        <div>
          <div className="jp-kicker">{t('credit.accounts')}</div>
          <div className="jp-num" style={{ fontFamily: 'var(--font-heading)', fontSize: 24 }}>
            {rows.filter((d) => d.balancePaisa > 0).length}
          </div>
        </div>
        <div style={{ marginInlineStart: 'auto', fontSize: 11.5, opacity: 0.55, maxWidth: 320 }}>
          {t('credit.ledgerNote')}
        </div>
      </div>

      <div style={{ background: 'var(--color-surface)', borderRadius: 24, padding: '8px 18px 14px' }}>
        {debtors.isLoading ? (
          <div style={{ display: 'grid', placeItems: 'center', padding: 50 }}>
            <Spin />
          </div>
        ) : rows.length === 0 ? (
          <div style={{ padding: '34px 22px', textAlign: 'center', opacity: 0.55, fontSize: 13 }}>
            {t('credit.nobody')}
          </div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table className="table jp-num">
              <thead>
                <tr>
                  <th>{t('credit.col.name')}</th>
                  <th>{t('credit.col.phone')}</th>
                  <th>{t('credit.col.last')}</th>
                  <th>{t('credit.col.owes')}</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {rows.map((d) => (
                  <tr key={d.partyId}>
                    <td style={{ fontWeight: 600 }}>{d.name}</td>
                    <td style={{ opacity: 0.7 }}>{d.phone ?? '—'}</td>
                    <td style={{ fontSize: 12, opacity: 0.7 }}>{stamp(d.lastEntryDate)}</td>
                    <td
                      style={{
                        fontWeight: 600,
                        // A negative balance means the SHOP owes them — worth
                        // showing differently so it is not read as a debt.
                        opacity: d.balancePaisa === 0 ? 0.45 : 1,
                      }}
                    >
                      {d.balancePaisa < 0
                        ? t('credit.shopOwes', { amount: rs(-d.balancePaisa) })
                        : rs(d.balancePaisa)}
                    </td>
                    <td>
                      <button className="btn btn-ghost" onClick={() => setOpenParty(d)}>
                        {t('credit.open')}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <StatementModal
        party={openParty}
        canTakeMoney={canTakeMoney}
        onClose={() => setOpenParty(null)}
      />
    </Screen>
  );
}

/** One customer's statement, with the repayment form under it. */
function StatementModal({
  party,
  canTakeMoney,
  onClose,
}: {
  party: Debtor | null;
  canTakeMoney: boolean;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const { message } = AntApp.useApp();
  const qc = useQueryClient();

  const [amount, setAmount] = useState('');
  const [method, setMethod] = useState<'CASH' | 'BANK' | 'CARD'>('CASH');

  const statement = useQuery({
    queryKey: ['credit', 'statement', party?.partyId],
    queryFn: () => api['credit.statement']({ partyId: party!.partyId }),
    enabled: party != null,
  });

  const rows = statement.data ?? [];
  const balance = rows.at(-1)?.balanceAfterPaisa ?? 0;

  const repay = useMutation({
    mutationFn: () =>
      api['credit.repay']({
        partyId: party!.partyId,
        amountPaisa: parseRs(amount),
        method,
      }),
    onSuccess: (res) => {
      message.success(t('credit.paymentTaken'));
      setAmount('');
      void qc.invalidateQueries({ queryKey: ['credit'] });
      if (res.balancePaisa === 0) onClose();
    },
    onError: (e: Error) => message.error(e.message),
  });

  const entered = amount.trim() ? parseRs(amount) : 0;
  const canPay = entered > 0 && entered <= balance && !repay.isPending;

  return (
    <Modal
      title={party ? `${party.name} · ${rs(balance)}` : ''}
      open={party != null}
      onCancel={onClose}
      footer={null}
      width={680}
      destroyOnHidden
    >
      {statement.isLoading ? (
        <div style={{ display: 'grid', placeItems: 'center', padding: 50 }}>
          <Spin />
        </div>
      ) : (
        <>
          <div style={{ overflowX: 'auto', maxHeight: 340 }}>
            <table className="table jp-num">
              <thead>
                <tr>
                  <th>{t('credit.col.date')}</th>
                  <th>{t('credit.col.what')}</th>
                  <th>{t('credit.col.bill')}</th>
                  <th>{t('credit.col.amount')}</th>
                  <th>{t('credit.col.balance')}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id}>
                    <td style={{ fontSize: 12, opacity: 0.7 }}>{stamp(r.entryDate)}</td>
                    <td>
                      {ENTRY_LABEL[r.entryType] ?? r.entryType}
                      {r.method && <span style={{ opacity: 0.6 }}> · {r.method}</span>}
                    </td>
                    <td style={{ fontSize: 12, opacity: 0.7 }}>{r.docNumber ?? '—'}</td>
                    <td style={{ fontWeight: 600 }}>
                      {r.amountPaisa > 0 ? `+ ${rs(r.amountPaisa)}` : `− ${rs(-r.amountPaisa)}`}
                    </td>
                    <td>{rs(r.balanceAfterPaisa)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {canTakeMoney && balance > 0 && (
            <div
              style={{
                display: 'flex',
                gap: 12,
                alignItems: 'flex-end',
                marginTop: 18,
                flexWrap: 'wrap',
              }}
            >
              <div className="field" style={{ width: 160 }}>
                <label>{t('credit.takePayment')}</label>
                <input
                  className="input jp-num"
                  value={amount}
                  placeholder="0"
                  onChange={(e) => setAmount(e.target.value)}
                />
              </div>
              <div className="field" style={{ width: 130 }}>
                <label>{t('credit.via')}</label>
                <Select
                  value={method}
                  onChange={setMethod}
                  options={(['CASH', 'BANK', 'CARD'] as const).map((m) => ({
                    value: m,
                    label: m,
                  }))}
                  style={{ width: '100%' }}
                />
              </div>
              <button
                className="btn btn-secondary"
                onClick={() => setAmount(String(balance / 100))}
              >
                {t('credit.payAll')}
              </button>
              <button className="btn btn-primary" disabled={!canPay} onClick={() => repay.mutate()}>
                {repay.isPending ? <Spin size="small" /> : t('credit.record')}
              </button>
              {entered > balance && (
                <div style={{ fontSize: 11.5, opacity: 0.7, width: '100%' }}>
                  {t('credit.overPayment')}
                </div>
              )}
            </div>
          )}
        </>
      )}
    </Modal>
  );
}
