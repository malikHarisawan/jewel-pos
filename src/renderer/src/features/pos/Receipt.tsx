import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Modal, Spin } from 'antd';
import { api } from '../../lib/api.js';
import { amount, rs, rsSigned, g, stamp } from '../../lib/format.js';
import type { z } from 'zod';
import type { InvoiceDTO, InvoiceLineDTO } from '../../../../shared/contracts/index.js';

type Invoice = z.infer<typeof InvoiceDTO>;
type Line = z.infer<typeof InvoiceLineDTO>;

interface Props {
  invoiceId: number | null;
  open: boolean;
  onClose: () => void;
}

/** Receipt for a finalised invoice, laid out as the A5 sheet it prints on.
 * `window.print()` produces the paper copy — the print CSS hides the app chrome
 * and leaves only `.receipt`. ESC/POS thermal printing lands in a later pass. */
export function Receipt({ invoiceId, open, onClose }: Props) {
  const { t } = useTranslation();
  const inv = useQuery({
    queryKey: ['sales', 'invoice', invoiceId],
    queryFn: () => api['sales.getInvoice']({ id: invoiceId! }),
    enabled: open && invoiceId != null,
  });
  const settings = useQuery({ queryKey: ['settings'], queryFn: () => api['settings.get']({}) });

  return (
    <Modal
      title={null}
      open={open}
      onCancel={onClose}
      footer={null}
      width={700}
      styles={{ body: { background: 'var(--jp-desk)' } }}
      destroyOnHidden
    >
      {inv.isLoading || !inv.data ? (
        <div style={{ display: 'grid', placeItems: 'center', padding: 60 }}>
          <Spin size="large" />
        </div>
      ) : (
        <>
          <div
            className="jp-noprint"
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              marginBottom: 14,
              gap: 12,
            }}
          >
            <div>
              <h4 style={{ margin: 0, fontSize: 18, whiteSpace: 'nowrap' }}>
                {t('pos.receiptTitle')} {inv.data.docNumber ?? ''}
              </h4>
              <div style={{ fontSize: 11.5, opacity: 0.6 }}>A5 · 148 × 210 mm</div>
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <button className="btn btn-secondary" onClick={onClose}>
                {t('common.close')}
              </button>
              <button className="btn btn-primary" onClick={() => window.print()}>
                {t('pos.print')} · Ctrl P
              </button>
            </div>
          </div>
          <ReceiptBody
            inv={inv.data}
            shop={{
              name: settings.data?.shop_name ?? '',
              address: settings.data?.shop_address ?? '',
              phone: settings.data?.shop_phone ?? '',
            }}
            taxPct={Number(settings.data?.tax_rate_bp ?? 0) / 100}
            metalExempt={settings.data?.tax_base === 'TOTAL_MINUS_METAL'}
          />
        </>
      )}
    </Modal>
  );
}

function ReceiptBody({
  inv,
  shop,
  taxPct,
  metalExempt,
}: {
  inv: Invoice;
  shop: { name: string; address: string; phone: string };
  taxPct: number;
  metalExempt: boolean;
}) {
  // The printed sheet is deliberately plain: white ground, hairline rules and
  // black text, so it reads on cheap paper and survives a fax or a photocopy.
  const subtotal =
    inv.grandTotalPaisa -
    inv.taxPaisa -
    inv.roundingPaisa -
    inv.saleAdjustmentPaisa +
    inv.discountPaisa;

  return (
    <div
      className="receipt"
      style={{
        background: '#fff',
        color: 'var(--color-text)',
        borderRadius: 6,
        padding: '34px 36px',
        boxShadow: '0 12px 34px color-mix(in srgb, var(--color-neutral-900) 24%, transparent)',
        fontSize: 12,
      }}
    >
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'flex-start',
          gap: 20,
          borderBottom: '1.5px solid var(--color-text)',
          paddingBottom: 12,
          marginBottom: 14,
        }}
      >
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontFamily: 'var(--font-heading)', fontSize: 22, lineHeight: 1.15 }}>
            {shop.name}
          </div>
          {shop.address && (
            <div style={{ fontSize: 11, opacity: 0.7, marginTop: 3 }}>{shop.address}</div>
          )}
          {shop.phone && (
            <div className="jp-num" style={{ fontSize: 11, opacity: 0.7 }}>
              Tel {shop.phone}
            </div>
          )}
        </div>
        <div style={{ textAlign: 'end', flex: 'none', whiteSpace: 'nowrap' }}>
          <div
            style={{ fontSize: 10, letterSpacing: '.12em', textTransform: 'uppercase', opacity: 0.6 }}
          >
            Sales invoice
          </div>
          <div className="jp-num" style={{ fontFamily: 'var(--font-heading)', fontSize: 19 }}>
            {inv.docNumber ?? '—'}
          </div>
          <div className="jp-num" style={{ fontSize: 11, opacity: 0.7 }}>
            {stamp(inv.docDate)}
          </div>
        </div>
      </div>

      {inv.customerName && (
        <div style={{ fontSize: 11.5, marginBottom: 14 }}>
          <span style={{ opacity: 0.55 }}>Customer</span> <strong>{inv.customerName}</strong>
        </div>
      )}

      <table className="table jp-num" style={{ fontSize: 11 }}>
        <thead>
          <tr>
            <th style={{ padding: '5px 4px' }}>Item</th>
            <th style={{ padding: '5px 4px' }}>Net</th>
            <th style={{ padding: '5px 4px' }}>Metal</th>
            <th style={{ padding: '5px 4px' }}>Making</th>
            <th style={{ padding: '5px 4px' }}>Wast.</th>
            <th style={{ padding: '5px 4px' }}>Hall.</th>
            <th style={{ padding: '5px 4px', textAlign: 'end' }}>Amount</th>
          </tr>
        </thead>
        <tbody>
          {inv.lines.map((l: Line, i) => (
            <tr key={i}>
              <td style={{ padding: '6px 4px' }}>
                <div style={{ fontWeight: 600 }}>{l.description}</div>
                <div style={{ fontSize: 9.5, opacity: 0.55 }}>
                  {l.lineKind === 'OLD_GOLD_EXCHANGE' ? 'EXCHANGE' : `${l.pieces} pc`}
                  {l.ratePaisaPerGram > 0 && ` · Rs ${amount(l.ratePaisaPerGram)}/g`}
                </div>
              </td>
              <td style={{ padding: '6px 4px' }}>{l.netMg ? `${g(l.netMg)} g` : '—'}</td>
              <td style={{ padding: '6px 4px' }}>{amount(l.metalValuePaisa)}</td>
              <td style={{ padding: '6px 4px' }}>{amount(l.makingValuePaisa)}</td>
              <td style={{ padding: '6px 4px' }}>{amount(l.wastageValuePaisa)}</td>
              <td style={{ padding: '6px 4px' }}>{amount(l.hallmarkChargePaisa)}</td>
              <td style={{ padding: '6px 4px', textAlign: 'end', fontWeight: 600 }}>
                {rs(l.lineTotalPaisa)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 26, marginTop: 16 }}>
        <div style={{ flex: 1, fontSize: 10.5, opacity: 0.7, lineHeight: 1.5 }}>
          <div
            style={{
              fontSize: 9.5,
              letterSpacing: '.1em',
              textTransform: 'uppercase',
              opacity: 0.7,
              marginBottom: 4,
            }}
          >
            Payment
          </div>
          {inv.payments.map((p, i) => (
            <div
              key={i}
              className="jp-num"
              style={{ display: 'flex', justifyContent: 'space-between', maxWidth: 170 }}
            >
              <span>{p.method}</span>
              <span>{rs(p.amountPaisa)}</span>
            </div>
          ))}
          <div style={{ marginTop: 10 }}>
            Old gold taken in exchange is credited as a negative line. Finalised invoices cannot be
            edited — only reversed by a credit note.
          </div>
        </div>

        <div style={{ width: 230 }}>
          <TotalRow label="Subtotal" value={rs(subtotal)} />
          {inv.discountPaisa !== 0 && <TotalRow label="Discount" value={rs(inv.discountPaisa)} />}
          {inv.exchangeValuePaisa !== 0 && (
            <TotalRow label="Old gold" value={rs(inv.exchangeValuePaisa)} />
          )}
          {inv.taxPaisa > 0 && (
            <TotalRow
              label={`Sales tax ${taxPct}%${metalExempt ? ' (metal exempt)' : ''}`}
              value={rs(inv.taxPaisa)}
            />
          )}
          {inv.saleAdjustmentPaisa !== 0 && (
            <TotalRow label="Adjustment" value={rsSigned(inv.saleAdjustmentPaisa)} />
          )}
          {inv.roundingPaisa !== 0 && (
            <TotalRow label="Rounding" value={rsSigned(inv.roundingPaisa)} />
          )}
          <div
            className="jp-num"
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'baseline',
              borderTop: '1.5px solid var(--color-text)',
              marginTop: 7,
              paddingTop: 7,
              gap: 10,
            }}
          >
            <span style={{ fontSize: 10, letterSpacing: '.1em', textTransform: 'uppercase' }}>
              Payable
            </span>
            <span style={{ fontFamily: 'var(--font-heading)', fontSize: 20 }}>
              {rs(inv.grandTotalPaisa)}
            </span>
          </div>
          <div
            style={{
              marginTop: 34,
              borderTop: '1px solid color-mix(in srgb, var(--color-text) 40%, transparent)',
              paddingTop: 5,
              fontSize: 10,
              opacity: 0.6,
              textAlign: 'center',
            }}
          >
            Received with thanks
          </div>
        </div>
      </div>
    </div>
  );
}

function TotalRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="jp-num" style={{ display: 'flex', justifyContent: 'space-between', padding: '3px 0', gap: 10 }}>
      <span style={{ opacity: 0.65 }}>{label}</span>
      <span>{value}</span>
    </div>
  );
}
