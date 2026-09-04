import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { App as AntApp, Modal, Select, Spin } from 'antd';
import { api } from '../../lib/api.js';
import { rs, g, parseG } from '../../lib/format.js';
import { gramsToMg, mgToGrams } from '../../../../shared/units/index.js';
import type { z } from 'zod';
import type { ReturnableLineDTO } from '../../../../shared/contracts/index.js';

type Line = z.infer<typeof ReturnableLineDTO>;

interface Props {
  invoiceId: number | null;
  docNumber: string | null;
  open: boolean;
  onClose: () => void;
  onDone: () => void;
}

const METHODS = ['CASH', 'BANK', 'CARD', 'CREDIT'] as const;

/** Take goods back against a finalised bill.
 *
 * The customer is refunded what they PAID on that line, not today's value, so
 * the amount shown here is derived from the original invoice and never from the
 * live rate. Lines already fully returned are shown but locked, so the counter
 * can see that the ring came back last week rather than wondering. */
export function ReturnModal({ invoiceId, docNumber, open, onClose, onDone }: Props) {
  const { t } = useTranslation();
  const { message } = AntApp.useApp();
  const qc = useQueryClient();

  // grams the counter is giving back, keyed by line id
  const [give, setGive] = useState<Record<number, number>>({});
  const [method, setMethod] = useState<(typeof METHODS)[number]>('CASH');
  const [reason, setReason] = useState('');

  const lines = useQuery({
    queryKey: ['sales', 'returnable', invoiceId],
    queryFn: () => api['sales.returnableLines']({ documentId: invoiceId! }),
    enabled: open && invoiceId != null,
  });

  // Start clean every time the modal opens on a different bill.
  useEffect(() => {
    if (open) {
      setGive({});
      setReason('');
      setMethod('CASH');
    }
  }, [open, invoiceId]);

  const rows: Line[] = lines.data ?? [];

  const setGrams = (line: Line, grams: number) => {
    const mg = Math.min(Math.max(gramsToMg(grams), 0), line.remainingNetMg);
    setGive((s) => ({ ...s, [line.lineId]: mg }));
  };

  // Refund preview, computed the same way the server does: the returned share
  // of what the line originally charged.
  const refundPaisa = useMemo(
    () =>
      rows.reduce((sum, l) => {
        const mg = give[l.lineId] ?? 0;
        if (mg <= 0) return sum;
        const full = mg === l.netMg;
        return sum + (full ? l.lineTotalPaisa : Math.round((l.lineTotalPaisa * mg) / l.netMg));
      }, 0),
    [rows, give],
  );

  const selected = rows.filter((l) => (give[l.lineId] ?? 0) > 0);

  const submit = useMutation({
    mutationFn: () =>
      api['sales.return']({
        documentId: invoiceId!,
        lines: selected.map((l) => {
          const mg = give[l.lineId];
          // A whole line returns all its pieces; a part of a lot returns one.
          const pieces = mg === l.netMg ? l.pieces : 1;
          return { lineId: l.lineId, pieces, netMg: mg };
        }),
        refundMethod: method,
        reason: reason.trim() || null,
      }),
    onSuccess: (res) => {
      message.success(t('returns.done', { no: res.docNumber }));
      void qc.invalidateQueries({ queryKey: ['sales'] });
      void qc.invalidateQueries({ queryKey: ['items'] });
      void qc.invalidateQueries({ queryKey: ['stock'] });
      void qc.invalidateQueries({ queryKey: ['dashboard'] });
      onDone();
      onClose();
    },
    onError: (e: Error) => message.error(e.message),
  });

  return (
    <Modal
      title={`${t('returns.title')} · ${docNumber ?? ''}`}
      open={open}
      onCancel={onClose}
      footer={null}
      width={720}
      destroyOnHidden
    >
      {lines.isLoading ? (
        <div style={{ display: 'grid', placeItems: 'center', padding: 50 }}>
          <Spin />
        </div>
      ) : (
        <>
          <div style={{ fontSize: 12.5, opacity: 0.65, marginBottom: 14, lineHeight: 1.5 }}>
            {t('returns.priceNote')}
          </div>

          <div style={{ overflowX: 'auto' }}>
            <table className="table jp-num">
              <thead>
                <tr>
                  <th>{t('returns.col.item')}</th>
                  <th>{t('returns.col.sold')}</th>
                  <th>{t('returns.col.alreadyBack')}</th>
                  <th>{t('returns.col.giveBack')}</th>
                  <th>{t('returns.col.refund')}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((l) => {
                  const mg = give[l.lineId] ?? 0;
                  const exhausted = l.remainingNetMg <= 0;
                  const full = mg === l.netMg;
                  const refund = !mg
                    ? 0
                    : full
                      ? l.lineTotalPaisa
                      : Math.round((l.lineTotalPaisa * mg) / l.netMg);
                  return (
                    <tr key={l.lineId} style={{ opacity: exhausted ? 0.45 : 1 }}>
                      <td>{l.description}</td>
                      <td>
                        {g(l.netMg)} g
                        {l.pieces > 1 && (
                          <span style={{ opacity: 0.6 }}> · {l.pieces} pc</span>
                        )}
                      </td>
                      <td style={{ opacity: 0.7 }}>
                        {l.returnedNetMg > 0 ? `${g(l.returnedNetMg)} g` : '—'}
                      </td>
                      <td>
                        {exhausted ? (
                          <span className="tag tag-neutral" style={{ fontSize: 10.5 }}>
                            {t('returns.allBack')}
                          </span>
                        ) : (
                          <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                            <input
                              className="input jp-num"
                              style={{ width: 92 }}
                              value={mg ? mgToGrams(mg) : ''}
                              placeholder="0.000"
                              onChange={(e) => setGrams(l, parseG(e.target.value))}
                              aria-label={t('returns.col.giveBack')}
                            />
                            <button
                              className="btn btn-ghost"
                              style={{ fontSize: 11.5 }}
                              onClick={() => setGrams(l, mgToGrams(l.remainingNetMg))}
                            >
                              {t('returns.allOfIt')}
                            </button>
                          </div>
                        )}
                      </td>
                      <td style={{ fontWeight: 600 }}>{refund ? rs(refund) : '—'}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <div
            style={{
              display: 'flex',
              gap: 12,
              alignItems: 'flex-end',
              marginTop: 16,
              flexWrap: 'wrap',
            }}
          >
            <div className="field" style={{ width: 150 }}>
              <label>{t('returns.refundVia')}</label>
              <Select
                value={method}
                onChange={setMethod}
                options={METHODS.map((m) => ({ value: m, label: m }))}
                style={{ width: '100%' }}
              />
            </div>
            <div className="field" style={{ flex: 1, minWidth: 200 }}>
              <label>{t('returns.reason')}</label>
              <input
                className="input"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder={t('returns.reasonPh')}
              />
            </div>
            <div style={{ textAlign: 'end', minWidth: 150 }}>
              <div className="jp-kicker">{t('returns.totalRefund')}</div>
              <div
                className="jp-figure" style={{ fontSize: 24 }}
              >
                {rs(refundPaisa)}
              </div>
            </div>
          </div>

          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 18 }}>
            <button className="btn btn-secondary" onClick={onClose}>
              {t('common.close')}
            </button>
            <button
              className="btn btn-primary"
              disabled={selected.length === 0 || submit.isPending}
              onClick={() => submit.mutate()}
            >
              {submit.isPending ? <Spin size="small" /> : t('returns.confirm')}
            </button>
          </div>
        </>
      )}
    </Modal>
  );
}
