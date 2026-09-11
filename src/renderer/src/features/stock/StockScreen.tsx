import { Fragment, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { App as AntApp, Popconfirm, Select, Spin } from 'antd';
import { api } from '../../lib/api.js';
import { useStickyState } from '../../lib/useStickyState.js';
import { useSession } from '../../app/session.js';
import { Screen } from '../../app/AppShell.js';
import { g, stamp, weekdayDate, parseG, parseNum } from '../../lib/format.js';
import { REASON_CODES } from '../../../../shared/domain/enums.js';
import type { z } from 'zod';
import type { MovementDTO } from '../../../../shared/contracts/index.js';

type MovementRow = z.infer<typeof MovementDTO>;

/** Movement type → label + tag class. Grouped by direction so the ledger reads
 * at a glance: greens bring stock in, neutrals take it out. */
const MOVEMENT_STYLE: Record<string, [string, string]> = {
  OPENING: ['Opening', 'tag tag-accent-2'],
  PURCHASE_IN: ['Purchase in', 'tag tag-accent-2'],
  SALE_RETURN_IN: ['Sale return', 'tag tag-accent-2'],
  EXCHANGE_IN: ['Exchange in', 'tag tag-accent-2'],
  KARIGAR_RECEIVE: ['Karigar in', 'tag tag-accent-2'],
  SALE_OUT: ['Sale out', 'tag tag-neutral'],
  KARIGAR_ISSUE: ['Karigar out', 'tag tag-neutral'],
  ADJUSTMENT: ['Adjustment', 'tag tag-accent'],
  STOCKTAKE_ADJ: ['Stocktake', 'tag tag-accent'],
};

const styleFor = (type: string): [string, string] => MOVEMENT_STYLE[type] ?? [type, 'tag tag-neutral'];

/** Purchases: where metal enters the shop and where stock is corrected.
 *
 * Named "Purchases" in the nav rather than "Stock" because it read as a
 * duplicate of Items, which is the catalogue. This screen owns the three things
 * Items cannot do — purchase in, adjust, reverse — over an append-only ledger.
 * Nothing here can be edited or deleted; a mistake is corrected by reversing. */
export function StockScreen() {
  const { t } = useTranslation();
  const { session } = useSession();
  const canWrite = session?.role === 'OWNER' || session?.role === 'MANAGER';
  /** Which posting form is open, if any. Closed by default: this screen is read
   *  far more often than it is written to. */
  const [form, setForm] = useState<'purchase' | 'adjust' | null>(null);
  const qc = useQueryClient();
  const { message } = AntApp.useApp();



  const movements = useQuery({
    queryKey: ['stock', 'movements'],
    queryFn: () =>
      api['stock.movements']({
        // This screen is the purchase book, not the whole ledger. Sales leave
        // through the Sales screen and were only noise here.
        types: ['PURCHASE_IN', 'OPENING', 'SALE_RETURN_IN', 'EXCHANGE_IN', 'ADJUSTMENT'],
        limit: 500,
      }),
  });
  const items = useQuery({
    queryKey: ['items', 'list', ''],
    queryFn: () => api['items.list']({ limit: 500 }),
  });

  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ['stock'] });
    void qc.invalidateQueries({ queryKey: ['items'] });
    void qc.invalidateQueries({ queryKey: ['dashboard'] });
  };

  const reverse = useMutation({
    mutationFn: (movementId: number) =>
      api['stock.reverse']({ movementId, reasonCode: 'DATA_ENTRY_ERROR' }),
    onSuccess: () => {
      invalidate();
      message.success(t('stock.reversed'));
    },
    onError: (e: Error) => message.error(e.message),
  });

  const itemOptions = (items.data ?? []).map((i) => ({
    value: i.id,
    label: `${i.tagNumber ?? '—'} — ${i.name}`,
  }));

  return (
    <Screen
      title={t('nav.stock')}
      subtitle="A diary, not a list: one row per delivery, newest first. The same piece appears again every time more of it arrives."
      actions={
        canWrite ? (
          <div style={{ display: 'flex', gap: 8 }}>
            <button
              className="btn btn-primary"
              onClick={() => setForm((f) => (f === 'purchase' ? null : 'purchase'))}
            >
              {t('stock.purchase')}
            </button>
            <button
              className="btn btn-secondary"
              onClick={() => setForm((f) => (f === 'adjust' ? null : 'adjust'))}
            >
              {t('stock.adjust')}
            </button>
          </div>
        ) : undefined
      }
    >
      <div style={{ display: 'grid', gap: 16, alignItems: 'start' }}>
        {/* Posting forms open on demand. They used to occupy a permanent rail
            beside the history, which made a screen that is read far more often
            than written look like a data-entry form. Salesmen never see them. */}
        {canWrite && form === 'purchase' && (
          <PurchasePanel
            itemOptions={itemOptions}
            onPosted={() => {
              invalidate();
              setForm(null);
            }}
          />
        )}
        {canWrite && form === 'adjust' && (
          <AdjustmentPanel
            itemOptions={itemOptions}
            onPosted={() => {
              invalidate();
              setForm(null);
            }}
          />
        )}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          {/* Ledger */}
          <div style={{ background: 'var(--color-surface)', borderRadius: 24, padding: '14px 18px' }}>
            <div style={{ overflowX: 'auto' }}>
              <table className="table jp-num">
                <thead>
                  <tr>
                    <th>{t('stock.col.when')}</th>
                    <th>{t('stock.col.type')}</th>
                    <th>{t('items.col.name')}</th>
                    <th>{t('stock.col.pcs')}</th>
                    <th>{t('stock.col.netDelta')}</th>
                    <th>{t('stock.col.note')}</th>
                    <th>{t('stock.col.by')}</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {(movements.data ?? []).map((m: MovementRow, i, all) => {
                    const [label, cls] = styleFor(m.movementType);
                    const reversed = m.reversesMovementId != null;
                    // A dated heading whenever the day changes. This is the
                    // cheapest way to stop the screen reading as another
                    // catalogue: a catalogue has no dates, a diary does, and
                    // the repeated item names then obviously mean "arrived
                    // again" rather than "listed twice".
                    const dayOf = (r: MovementRow) => r.createdAt.slice(0, 10);
                    const newDay = i === 0 || dayOf(all[i - 1]) !== dayOf(m);
                    return (
                      <Fragment key={m.id}>
                      {newDay && (
                        <tr>
                          <td colSpan={8} style={{ padding: '14px 0 4px' }}>
                            <span className="jp-kicker">{weekdayDate(new Date(m.createdAt))}</span>
                          </td>
                        </tr>
                      )}
                      <tr className={reversed ? 'jp-row-muted' : undefined}>
                        <td style={{ fontSize: 11.5, opacity: 0.6, whiteSpace: 'nowrap' }}>
                          {stamp(m.createdAt).slice(11)}
                        </td>
                        <td>
                          <span className={reversed ? 'tag tag-outline' : cls}>
                            {reversed ? 'Reversal' : label}
                          </span>
                        </td>
                        <td>
                          <div style={{ fontSize: 13 }}>{m.itemName}</div>
                          <div style={{ fontSize: 10.5, opacity: 0.5 }}>{m.tagNumber ?? ''}</div>
                        </td>
                        <td>{m.piecesDelta > 0 ? `+${m.piecesDelta}` : m.piecesDelta}</td>
                        <td style={{ fontWeight: 600 }}>
                          {m.netMgDelta < 0 ? '−' : '+'}
                          {g(Math.abs(m.netMgDelta))}
                        </td>
                        <td style={{ fontSize: 11.5, opacity: 0.7 }}>
                          {/* Purchases carry the supplier / bill ref in notes;
                              adjustments carry a reason code instead. Show
                              whichever this row actually has. */}
                          {m.notes || m.reasonCode || '—'}
                        </td>
                        <td style={{ fontSize: 11.5, opacity: 0.6 }}>{m.createdByName}</td>
                        <td style={{ textAlign: 'end' }}>
                          {canWrite && !reversed && (
                            <Popconfirm
                              title={t('stock.reverseConfirm')}
                              onConfirm={() => reverse.mutate(m.id)}
                              okText={t('common.save')}
                            >
                              <button className="btn btn-ghost" style={{ fontSize: 12 }}>
                                {t('stock.reverse')}
                              </button>
                            </Popconfirm>
                          )}
                        </td>
                      </tr>
                      </Fragment>
                    );
                  })}
                  {movements.isLoading && (
                    <tr>
                      <td colSpan={8} style={{ textAlign: 'center', padding: 20 }}>
                        <Spin />
                      </td>
                    </tr>
                  )}
                  {!movements.isLoading && (movements.data ?? []).length === 0 && (
                    <tr>
                      <td colSpan={8} style={{ opacity: 0.55, padding: 16 }}>
                        No deliveries recorded yet. Adding a piece on Items lists what it is;
                        recording it here says when it arrived and from whom.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>


      </div>
    </Screen>
  );
}

interface PanelProps {
  itemOptions: { value: number; label: string }[];
  onPosted: () => void;
}

/** Bring stock in against a supplier bill. Pieces and weights are positive. */
function PurchasePanel({ itemOptions, onPosted }: PanelProps) {
  const { t } = useTranslation();
  const { message } = AntApp.useApp();
  const [itemId, setItemId] = useStickyState<number | undefined>('stock.in.itemId', undefined);
  const [pieces, setPieces] = useStickyState('stock.in.pieces', '1');
  const [gross, setGross] = useStickyState('stock.in.gross', '');
  const [less, setLess] = useStickyState('stock.in.less', '0.000');
  const [notes, setNotes] = useStickyState('stock.in.notes', '');

  const post = useMutation({
    mutationFn: () =>
      api['stock.purchaseIn']({
        itemId: itemId!,
        pieces: Math.round(parseNum(pieces)),
        grossMg: parseG(gross),
        netMg: parseG(gross) - parseG(less),
        notes: notes || undefined,
      }),
    onSuccess: () => {
      onPosted();
      message.success(t('stock.posted'));
      setGross('');
      setNotes('');
    },
    onError: (e: Error) => message.error(e.message),
  });

  const submit = () => {
    if (!itemId) return message.error('Pick an item.');
    if (!parseG(gross)) return message.error('Enter a gross weight.');
    post.mutate();
  };

  return (
    <div className="jp-panel">
      <div className="jp-kicker" style={{ marginBottom: 12 }}>
        {t('stock.purchase')}
      </div>
      <div className="field" style={{ marginBottom: 10 }}>
        <label>{t('stock.field.item')}</label>
        <Select
          value={itemId}
          onChange={setItemId}
          options={itemOptions}
          showSearch
          optionFilterProp="label"
          placeholder={t('common.chooseItem')}
          style={{ width: '100%' }}
        />
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '.6fr 1fr 1fr', gap: 10, marginBottom: 10 }}>
        <div className="field">
          <label>Pcs</label>
          <input className="input jp-num" value={pieces} onChange={(e) => setPieces(e.target.value)} />
        </div>
        <div className="field">
          <label>Gross (g)</label>
          <input
            className="input jp-num"
            value={gross}
            onChange={(e) => setGross(e.target.value)}
            placeholder="0.000"
          />
        </div>
        <div className="field">
          <label>Less (g)</label>
          <input className="input jp-num" value={less} onChange={(e) => setLess(e.target.value)} />
        </div>
      </div>
      <div className="field" style={{ marginBottom: 12 }}>
        <label>Supplier / bill ref</label>
        <input className="input" value={notes} onChange={(e) => setNotes(e.target.value)} />
      </div>
      <button className="btn btn-primary btn-block" disabled={post.isPending} onClick={submit}>
        Post purchase
      </button>
    </div>
  );
}

/** Signed correction to a balance. A reason code is mandatory — an unexplained
 * weight change is exactly what the ledger exists to prevent. */
function AdjustmentPanel({ itemOptions, onPosted }: PanelProps) {
  const { t } = useTranslation();
  const { message } = AntApp.useApp();
  const [itemId, setItemId] = useStickyState<number | undefined>('stock.adj.itemId', undefined);
  const [pieces, setPieces] = useStickyState('stock.adj.pieces', '0');
  const [gross, setGross] = useStickyState('stock.adj.gross', '');
  const [less, setLess] = useStickyState('stock.adj.less', '0.000');
  const [reason, setReason] = useStickyState<string | undefined>('stock.adj.reason', undefined);
  const [notes, setNotes] = useStickyState('stock.adj.notes', '');

  const post = useMutation({
    mutationFn: () =>
      api['stock.adjust']({
        itemId: itemId!,
        piecesDelta: Math.round(parseNum(pieces)),
        grossMgDelta: parseG(gross),
        netMgDelta: parseG(gross) - parseG(less),
        reasonCode: reason as (typeof REASON_CODES)[number],
        notes: notes || undefined,
      }),
    onSuccess: () => {
      onPosted();
      message.success(t('stock.posted'));
      setGross('');
      setNotes('');
    },
    onError: (e: Error) => message.error(e.message),
  });

  const submit = () => {
    if (!itemId) return message.error('Pick an item.');
    if (!reason) return message.error('An adjustment needs a reason code.');
    if (!parseG(gross) && !Math.round(parseNum(pieces)))
      return message.error('Enter a signed piece count or weight.');
    post.mutate();
  };

  return (
    <div className="jp-panel">
      <div className="jp-kicker">{t('stock.adjust')}</div>
      <div style={{ fontSize: 11.5, opacity: 0.6, margin: '4px 0 12px' }}>
        Signed values. A reason code is mandatory.
      </div>
      <div className="field" style={{ marginBottom: 10 }}>
        <label>{t('stock.field.item')}</label>
        <Select
          value={itemId}
          onChange={setItemId}
          options={itemOptions}
          showSearch
          optionFilterProp="label"
          placeholder="Choose an item"
          style={{ width: '100%' }}
        />
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '.6fr 1fr 1fr', gap: 10, marginBottom: 10 }}>
        <div className="field">
          <label>± Pcs</label>
          <input className="input jp-num" value={pieces} onChange={(e) => setPieces(e.target.value)} />
        </div>
        <div className="field">
          <label>± Gross (g)</label>
          <input
            className="input jp-num"
            value={gross}
            onChange={(e) => setGross(e.target.value)}
            placeholder="0.000"
          />
        </div>
        <div className="field">
          <label>± Less (g)</label>
          <input className="input jp-num" value={less} onChange={(e) => setLess(e.target.value)} />
        </div>
      </div>
      <div className="field" style={{ marginBottom: 10 }}>
        <label>{t('stock.field.reason')}</label>
        <Select
          value={reason}
          onChange={setReason}
          options={REASON_CODES.map((r) => ({ value: r, label: r }))}
          placeholder="— choose —"
          style={{ width: '100%' }}
        />
      </div>
      <div className="field" style={{ marginBottom: 12 }}>
        <label>{t('stock.field.notes')}</label>
        <input className="input" value={notes} onChange={(e) => setNotes(e.target.value)} />
      </div>
      <button className="btn btn-secondary btn-block" disabled={post.isPending} onClick={submit}>
        Post adjustment
      </button>
    </div>
  );
}
