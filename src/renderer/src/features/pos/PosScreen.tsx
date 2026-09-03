import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { App as AntApp, Select, Spin } from 'antd';
import { api } from '../../lib/api.js';
import { useCatalog } from '../items/useCatalog.js';
import { useSession } from '../../app/session.js';
import { Receipt } from './Receipt.js';
import { rs, g, gu, parseNum } from '../../lib/format.js';
import { gramsToMg, rupeesToPaisa } from '../../../../shared/units/index.js';
import type { ItemDTOType } from '../../../../shared/contracts/index.js';

interface CartLine {
  item: ItemDTOType;
  quoteTotalPaisa: number;
  hasRate: boolean;
  /** For LOT items: grams being sold from the pool (editable in the cart). Unique
   * items always sell their whole net weight, so this is undefined for them. */
  sellGrams?: number;
  /** For LOT items: number of pieces being sold. */
  sellPieces?: number;
}
interface OldGoldLine {
  key: number;
  purityId?: number;
  grams: number;
  touchPct: number;
}
interface PayLine {
  key: number;
  method: 'CASH' | 'CARD' | 'BANK' | 'CREDIT';
  rupees: number;
}

const METHODS: PayLine['method'][] = ['CASH', 'CARD', 'BANK', 'CREDIT'];

export function PosScreen() {
  const { t } = useTranslation();
  const { message } = AntApp.useApp();
  const catalog = useCatalog();
  const { session } = useSession();

  const [cart, setCart] = useState<CartLine[]>([]);
  const [oldGold, setOldGold] = useState<OldGoldLine[]>([]);
  const [payments, setPayments] = useState<PayLine[]>([{ key: 1, method: 'CASH', rupees: 0 }]);
  const [receiptId, setReceiptId] = useState<number | null>(null);
  const [keyCounter, setKeyCounter] = useState(2);
  const [search, setSearch] = useState('');
  const [ogOpen, setOgOpen] = useState(false);
  // Who the bill is for. Null is a walk-in, which is fine until the bill goes
  // on credit — then we need to know whose account to charge.
  const [customerId, setCustomerId] = useState<number | null>(null);
  const [newCustomer, setNewCustomer] = useState('');
  const qc = useQueryClient();

  // Price adjustment (all optional). Discount reduces; a custom total overrides.
  const [discountMode, setDiscountMode] = useState<'RS' | 'PCT'>('RS');
  const [discountValue, setDiscountValue] = useState<number>(0);
  const [customTotalRupees, setCustomTotalRupees] = useState<number | null>(null);
  // Whether the cashier has hand-edited payments (turns off exact auto-fill).
  const [paymentsTouched, setPaymentsTouched] = useState(false);

  // Item picker: in-stock items only.
  const items = useQuery({
    queryKey: ['items', 'list', ''],
    queryFn: () => api['items.list']({ status: 'IN_STOCK', limit: 500 }),
  });

  async function addItem(itemId: number) {
    if (cart.some((c) => c.item.id === itemId)) return;
    const item = items.data?.find((i) => i.id === itemId);
    if (!item) return;

    setSearch('');

    if (item.trackingMode === 'LOT') {
      // Bulk item: default to selling 1g / 1 piece from the pool; the cashier edits
      // the grams in the cart and the line re-prices.
      const startGrams = 1;
      const q = await api['rates.quoteWeight']({ itemId, netMg: Math.round(startGrams * 1000) });
      if (!q.hasRate) message.warning(t('pos.noRateWarn'));
      setCart((c) => [
        ...c,
        { item, quoteTotalPaisa: q.totalPaisa, hasRate: q.hasRate, sellGrams: startGrams, sellPieces: 1 },
      ]);
      return;
    }

    const [q] = await api['rates.quoteItems']({ itemIds: [itemId] });
    if (!q.hasRate) {
      message.warning(t('pos.noRateWarn'));
    }
    setCart((c) => [...c, { item, quoteTotalPaisa: q.totalPaisa, hasRate: q.hasRate }]);
  }

  // Per-line re-pricing state. Typing "12.5" used to fire four quotes, and a
  // slow early response could land after a later one and show the wrong price.
  // A timer per line debounces the call; a sequence number per line makes a
  // stale response identifiable so it can be dropped.
  const quoteTimers = useRef(new Map<number, ReturnType<typeof setTimeout>>());
  const quoteSeq = useRef(new Map<number, number>());

  // Cancel anything still pending when the screen goes away.
  useEffect(() => {
    const timers = quoteTimers.current;
    return () => {
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
    };
  }, []);

  /** Re-price a LOT cart line after the cashier changes the grams sold. */
  function updateLotGrams(itemId: number, grams: number) {
    setCart((c) => c.map((x) => (x.item.id === itemId ? { ...x, sellGrams: grams } : x)));

    const pending = quoteTimers.current.get(itemId);
    if (pending) clearTimeout(pending);
    if (grams <= 0) return;

    const seq = (quoteSeq.current.get(itemId) ?? 0) + 1;
    quoteSeq.current.set(itemId, seq);

    quoteTimers.current.set(
      itemId,
      setTimeout(() => {
        quoteTimers.current.delete(itemId);
        void api['rates.quoteWeight']({ itemId, netMg: Math.round(grams * 1000) }).then((q) => {
          // A newer keystroke has already been sent; this answer is out of date.
          if (quoteSeq.current.get(itemId) !== seq) return;
          setCart((c) =>
            c.map((x) =>
              x.item.id === itemId
                ? { ...x, quoteTotalPaisa: q.totalPaisa, hasRate: q.hasRate }
                : x,
            ),
          );
        });
      }, 250),
    );
  }

  const rates = useQuery({ queryKey: ['rates', 'latest'], queryFn: () => api['rates.latest']({}) });
  function latestRatePaisaPerGram(purityId?: number): number | null {
    if (purityId == null) return null;
    return rates.data?.find((r) => r.purityId === purityId)?.ratePaisaPerGram ?? null;
  }

  // Invoice rounding setting ('100' = nearest rupee, '1' = none) — must match the
  // server's rounding so the payable we show equals what checkout charges.
  const settings = useQuery({ queryKey: ['settings'], queryFn: () => api['settings.get']({}) });
  const roundStep = settings.data?.invoice_round_to === '1' ? 1 : 100;
  const roundToStep = (paisa: number): number => {
    if (roundStep === 1) return paisa;
    const sign = paisa < 0 ? -1 : 1;
    return sign * Math.floor((Math.abs(paisa) + roundStep / 2) / roundStep) * roundStep;
  };

  const customers = useQuery({
    queryKey: ['parties', 'CUSTOMER'],
    queryFn: () => api['parties.list']({ kind: 'CUSTOMER', limit: 500 }),
  });

  const addCustomer = useMutation({
    mutationFn: (name: string) => api['parties.create']({ kind: 'CUSTOMER', name }),
    onSuccess: (p) => {
      void qc.invalidateQueries({ queryKey: ['parties'] });
      setCustomerId(p.id);
      setNewCustomer('');
      message.success(t('pos.customerAdded', { name: p.name }));
    },
    onError: (e: Error) => message.error(e.message),
  });

  // What this customer already owes, so the counter can see it before agreeing
  // to put yet more on the book.
  const owed = useQuery({
    queryKey: ['credit', 'statement', customerId],
    queryFn: () => api['credit.statement']({ partyId: customerId! }),
    enabled: customerId != null,
  });
  const owedPaisa = owed.data?.at(-1)?.balanceAfterPaisa ?? 0;

  // ---- live totals (client-side estimate; server re-prices authoritatively) ----
  const saleTotal = cart.reduce((s, c) => s + c.quoteTotalPaisa, 0);
  const oldGoldTotal = oldGold.reduce((s, og) => {
    const rate = latestRatePaisaPerGram(og.purityId);
    if (!rate || !og.grams) return s;
    return s + Math.round((gramsToMg(og.grams) * (og.touchPct / 100) * rate) / 1000);
  }, 0);
  // Sum of line totals, before any counter adjustment.
  const computedPayable = saleTotal - oldGoldTotal;
  // What the SERVER uses as its base: the sum rounded to the invoice step.
  const serverBase = roundToStep(computedPayable);

  // Discount amount in paisa (from Rs or % of the computed payable).
  const discountPaisa =
    discountMode === 'PCT'
      ? Math.round((computedPayable * (discountValue || 0)) / 100)
      : rupeesToPaisa(discountValue || 0);

  // Final amount to charge. A custom total wins; otherwise the rounded base minus
  // the discount, itself rounded to the invoice step so the cashier pays a clean
  // figure that the server will accept exactly.
  const finalPayable =
    customTotalRupees != null
      ? rupeesToPaisa(customTotalRupees)
      : Math.max(0, roundToStep(serverBase - discountPaisa));

  // Signed adjustment relative to the SERVER's rounded base, so that
  // serverBase + adjustment === finalPayable === the payment. This is what makes
  // "Pay exact" match the server's grand total and pass the payment check.
  const saleAdjustmentPaisa = finalPayable - serverBase;

  // The server caps how far this role may cut a bill (see assertDiscountAllowed).
  // Mirror it here so the counter sees the limit BEFORE pressing F9, rather than
  // getting a rejection after the customer is already waiting.
  const discountCapPct = Number(
    session?.role === 'SALESMAN'
      ? settings.data?.max_discount_pct_salesman
      : settings.data?.max_discount_pct_manager,
  );
  const capPct = Number.isFinite(discountCapPct) ? discountCapPct : null;
  const appliedDiscountPaisa = saleAdjustmentPaisa < 0 ? -saleAdjustmentPaisa : 0;
  const discountOverLimit =
    capPct != null &&
    appliedDiscountPaisa > 0 &&
    (serverBase <= 0 || appliedDiscountPaisa > Math.floor((serverBase * capPct) / 100));

  // A CREDIT line means the customer walks out owing money, so the server needs
  // to know whose account to charge. Mirror that here rather than letting the
  // sale fail at F9 with the customer standing at the counter.
  const creditPaisa = payments
    .filter((p) => p.method === 'CREDIT')
    .reduce((s, p) => s + rupeesToPaisa(p.rupees || 0), 0);
  const creditNeedsCustomer = creditPaisa > 0 && customerId == null;

  const paid = payments.reduce((s, p) => s + rupeesToPaisa(p.rupees || 0), 0);
  const remaining = finalPayable - paid;

  // Auto-fill: keep the single (untouched) payment row equal to the payable, so
  // the cashier just clicks Complete. Splitting or editing turns this off.
  useEffect(() => {
    if (paymentsTouched) return;
    if (payments.length !== 1) return;
    const target = finalPayable / 100; // rupees
    if (payments[0].rupees !== target) {
      setPayments([{ ...payments[0], rupees: target }]);
    }
  }, [finalPayable, paymentsTouched, payments]);

  const checkout = useMutation({
    mutationFn: () =>
      api['sales.checkout']({
        customerId,
        saleLines: cart.map((c) => {
          const isLot = c.item.trackingMode === 'LOT';
          const netMg = isLot ? Math.round((c.sellGrams ?? 0) * 1000) : c.item.netMg;
          const grossMg = isLot ? netMg : c.item.grossMg;
          const pieces = isLot ? c.sellPieces ?? 1 : 1;
          const label = isLot ? `${c.sellGrams ?? 0}g` : '';
          return {
            itemId: c.item.id,
            pieces,
            netMg,
            grossMg,
            purityId: c.item.purityId,
            wastageBp: c.item.wastageBp,
            making: { mode: c.item.makingMode, ratePaisa: c.item.makingRatePaisa },
            stones: [],
            hallmarkChargePaisa: isLot ? 0 : c.item.hallmarkChargePaisa,
            discountPaisa: 0,
            description: `${c.item.tagNumber ?? ''} ${c.item.name} ${label}`.trim(),
          };
        }),
        oldGoldLines: oldGold
          .filter((og) => og.purityId != null && og.grams > 0)
          .map((og) => ({
            purityId: og.purityId!,
            netMg: gramsToMg(og.grams),
            grossMg: gramsToMg(og.grams),
            touchBp: Math.round(og.touchPct * 100),
            description: `Old gold ${og.grams}g @ ${og.touchPct}%`,
          })),
        payments: payments
          .filter((p) => p.rupees > 0)
          .map((p) => ({ method: p.method, amountPaisa: rupeesToPaisa(p.rupees) })),
        saleAdjustmentPaisa,
      }),
    onSuccess: (res) => {
      message.success(t('pos.done', { no: res.docNumber }));
      setReceiptId(res.documentId);
      setCart([]);
      setOldGold([]);
      setPayments([{ key: 1, method: 'CASH', rupees: 0 }]);
      setDiscountValue(0);
      setCustomTotalRupees(null);
      setCustomerId(null);
      setPaymentsTouched(false);
      setOgOpen(false);
      void items.refetch();
    },
    onError: (e: Error) => message.error(e.message),
  });

  const canCheckout =
    cart.length > 0 &&
    paid === finalPayable &&
    finalPayable >= 0 &&
    !discountOverLimit &&
    !creditNeedsCustomer;

  // Type-ahead results. The scanner types a tag and presses Enter; the top match
  // is what gets added, so the whole flow is keyboard-only.
  const results = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return [];
    return (items.data ?? [])
      .filter((i) => `${i.tagNumber ?? ''} ${i.name}`.toLowerCase().includes(q))
      .slice(0, 6);
  }, [search, items.data]);

  // F9 finalises, Escape closes the old-gold drawer — counter muscle memory.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'F9') {
        e.preventDefault();
        if (canCheckout && !checkout.isPending) checkout.mutate();
      }
      if (e.key === 'Escape' && ogOpen) setOgOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [canCheckout, checkout, ogOpen]);

  const purityOptions = (catalog.data?.purities ?? []).map((p) => ({ value: p.id, label: p.label }));

  return (
    <div style={{ flex: 1, display: 'flex', minHeight: 0 }}>
      {/* ── left: search, results, cart ── */}
      <div
        style={{
          flex: 1,
          minWidth: 0,
          display: 'flex',
          flexDirection: 'column',
          padding: '22px 22px 0 30px',
          overflow: 'auto',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 14 }}>
          <div style={{ flex: 1, position: 'relative' }}>
            <input
              className="input"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && results[0]) void addItem(results[0].id);
              }}
              placeholder={t('pos.scanPh')}
              style={{ height: 46, fontSize: 15, paddingInlineStart: 42 }}
            />
            <svg
              width="17"
              height="17"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.75"
              strokeLinecap="round"
              style={{ position: 'absolute', insetInlineStart: 15, top: 14, opacity: 0.45 }}
            >
              <path d="m21 21-4.34-4.34M11 3a8 8 0 1 0 0 16 8 8 0 0 0 0-16" />
            </svg>
          </div>
          <button className="btn btn-secondary" onClick={() => setOgOpen((v) => !v)}>
            {t('pos.oldGold')}
          </button>
        </div>

        {results.length > 0 && (
          <div
            style={{
              background: 'var(--color-surface)',
              borderRadius: 22,
              padding: 8,
              marginBottom: 12,
              boxShadow: 'var(--shadow-md)',
            }}
          >
            {results.map((i) => (
              <button key={i.id} className="jp-rowbtn" onClick={() => void addItem(i.id)}>
                <span className={i.trackingMode === 'ITEM' ? 'tag tag-accent' : 'tag tag-accent-2'}>
                  {i.trackingMode === 'ITEM' ? 'UNIQUE' : 'LOT'}
                </span>
                <span style={{ flex: 1 }}>
                  <span style={{ fontWeight: 600 }}>{i.name}</span>{' '}
                  <span style={{ fontSize: 11.5, opacity: 0.5 }}>{i.tagNumber ?? ''}</span>
                  <br />
                  <span style={{ fontSize: 11.5, opacity: 0.55 }}>
                    {i.balancePieces} pc · {gu(i.balanceNetMg)}
                  </span>
                </span>
              </button>
            ))}
          </div>
        )}

        {/* Old gold taken in exchange — a dark drawer, because it credits the
            bill rather than charging it. */}
        {ogOpen && (
          <div
            className="jp-on-ink"
            style={{
              background: 'var(--jp-ink)',
              color: 'var(--color-bg)',
              borderRadius: 22,
              padding: '16px 18px',
              marginBottom: 12,
            }}
          >
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                marginBottom: 10,
              }}
            >
              <div
                style={{
                  fontSize: 10,
                  letterSpacing: '.12em',
                  textTransform: 'uppercase',
                  color: 'var(--color-accent-400)',
                }}
              >
                {t('pos.oldGold')}
              </div>
              <button
                className="btn"
                style={{ color: 'var(--color-bg)', fontSize: 12 }}
                onClick={() => {
                  setOldGold((gs) => [...gs, { key: keyCounter, grams: 0, touchPct: 91.6 }]);
                  setKeyCounter((k) => k + 1);
                }}
              >
                {t('pos.addOldGold')}
              </button>
            </div>

            {oldGold.length === 0 ? (
              <div style={{ fontSize: 12.5, opacity: 0.65 }}>{t('pos.noOldGold')}</div>
            ) : (
              oldGold.map((og) => {
                const rate = latestRatePaisaPerGram(og.purityId);
                const credit =
                  rate && og.grams
                    ? Math.round((gramsToMg(og.grams) * (og.touchPct / 100) * rate) / 1000)
                    : 0;
                return (
                  <div
                    key={og.key}
                    style={{
                      display: 'grid',
                      gridTemplateColumns: '1fr 1fr 1fr auto auto',
                      gap: 10,
                      alignItems: 'end',
                      marginBottom: 10,
                    }}
                  >
                    <div className="field">
                      <label>{t('items.field.purity')}</label>
                      <Select
                        value={og.purityId}
                        onChange={(v) =>
                          setOldGold((gs) => gs.map((x) => (x.key === og.key ? { ...x, purityId: v } : x)))
                        }
                        options={purityOptions}
                        style={{ width: '100%' }}
                        placeholder="Purity"
                      />
                    </div>
                    <div className="field">
                      <label>Weight (g)</label>
                      <input
                        className="input jp-num"
                        value={og.grams || ''}
                        placeholder="0.000"
                        onChange={(e) =>
                          setOldGold((gs) =>
                            gs.map((x) =>
                              x.key === og.key ? { ...x, grams: parseNum(e.target.value) } : x,
                            ),
                          )
                        }
                      />
                    </div>
                    <div className="field">
                      <label>% touch</label>
                      <input
                        className="input jp-num"
                        value={og.touchPct}
                        onChange={(e) =>
                          setOldGold((gs) =>
                            gs.map((x) =>
                              x.key === og.key ? { ...x, touchPct: parseNum(e.target.value) } : x,
                            ),
                          )
                        }
                      />
                    </div>
                    <div
                      className="jp-num"
                      style={{ paddingBottom: 8, fontWeight: 600, whiteSpace: 'nowrap' }}
                    >
                      − {rs(credit)}
                    </div>
                    <button
                      className="btn"
                      style={{ color: 'var(--color-accent-300)', paddingBottom: 8 }}
                      onClick={() => setOldGold((gs) => gs.filter((x) => x.key !== og.key))}
                      aria-label="Remove"
                    >
                      ✕
                    </button>
                  </div>
                );
              })
            )}
          </div>
        )}

        {/* Cart */}
        <div style={{ background: 'var(--color-surface)', borderRadius: 24, padding: '14px 18px' }}>
          <h4 style={{ margin: '0 0 10px', fontSize: 17 }}>{t('pos.cart')}</h4>
          {cart.length === 0 ? (
            <div style={{ opacity: 0.55, fontSize: 13, padding: '12px 0' }}>{t('pos.emptyCart')}</div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {cart.map((c) => {
                const isLot = c.item.trackingMode === 'LOT';
                return (
                  <div
                    key={c.item.id}
                    style={{
                      background: 'var(--color-bg)',
                      borderRadius: 18,
                      padding: '11px 14px',
                      display: 'flex',
                      alignItems: 'center',
                      gap: 12,
                      flexWrap: 'wrap',
                    }}
                  >
                    <span className={isLot ? 'tag tag-accent-2' : 'tag tag-accent'}>
                      {isLot ? 'LOT' : 'UNIQUE'}
                    </span>
                    <div style={{ flex: 1, minWidth: 160 }}>
                      <div style={{ fontWeight: 600 }}>{c.item.name}</div>
                      <div className="jp-num" style={{ fontSize: 11, opacity: 0.55 }}>
                        {c.item.tagNumber ?? ''}
                        {!isLot && ` · ${gu(c.item.netMg)} net`}
                      </div>
                    </div>

                    {isLot ? (
                      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                        <input
                          className="input jp-num"
                          style={{ width: 96 }}
                          value={c.sellGrams ?? ''}
                          onChange={(e) => updateLotGrams(c.item.id, parseNum(e.target.value))}
                          aria-label="Grams"
                        />
                        <span style={{ fontSize: 12, opacity: 0.6 }}>g</span>
                        <input
                          className="input jp-num"
                          style={{ width: 72 }}
                          value={c.sellPieces ?? 1}
                          onChange={(e) =>
                            setCart((cs) =>
                              cs.map((x) =>
                                x.item.id === c.item.id
                                  ? { ...x, sellPieces: Math.max(1, Math.round(parseNum(e.target.value))) }
                                  : x,
                              ),
                            )
                          }
                          aria-label="Pieces"
                        />
                        <span style={{ fontSize: 12, opacity: 0.6 }}>pc</span>
                      </div>
                    ) : (
                      <span className="jp-num" style={{ fontSize: 12.5, opacity: 0.7 }}>
                        {g(c.item.netMg)} g
                      </span>
                    )}

                    <span
                      className="jp-num"
                      style={{ fontWeight: 600, minWidth: 120, textAlign: 'end' }}
                    >
                      {c.hasRate ? rs(c.quoteTotalPaisa) : t('items.noRate')}
                    </span>
                    <button
                      className="btn btn-ghost"
                      onClick={() => setCart((cs) => cs.filter((x) => x.item.id !== c.item.id))}
                      aria-label="Remove"
                    >
                      ✕
                    </button>
                  </div>
                );
              })}
            </div>
          )}
          {items.isLoading && <Spin size="small" style={{ marginTop: 8 }} />}
        </div>

        <div style={{ height: 22 }} />
      </div>

      {/* ── right: totals and payment ── */}
      <div
        style={{
          width: 400,
          flex: 'none',
          background: 'var(--color-surface)',
          display: 'flex',
          flexDirection: 'column',
          minHeight: 0,
        }}
      >
        <div style={{ flex: 1, overflow: 'auto', padding: '22px 22px 0' }}>
          <div className="jp-kicker" style={{ marginBottom: 12 }}>
            {t('pos.summary')}
          </div>

          <Row label={t('pos.saleTotal')} value={rs(saleTotal)} />
          {oldGoldTotal > 0 && (
            <Row label={t('pos.oldGoldCredit')} value={`− ${rs(oldGoldTotal)}`} />
          )}
          <Row label={t('pos.computed')} value={rs(computedPayable)} />

          <div style={{ height: 1, background: 'var(--color-divider)', margin: '12px 0' }} />

          {/* Discount + custom total override. */}
          <div className="field" style={{ marginBottom: 10 }}>
            <label>{t('pos.discount')}</label>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <input
                className="input jp-num"
                style={{ flex: 1 }}
                value={discountValue || ''}
                disabled={customTotalRupees != null}
                onChange={(e) => setDiscountValue(parseNum(e.target.value))}
                placeholder="0"
              />
              <div className="seg">
                <label className="seg-opt">
                  <input
                    type="radio"
                    name="discmode"
                    checked={discountMode === 'RS'}
                    disabled={customTotalRupees != null}
                    onChange={() => setDiscountMode('RS')}
                  />
                  Rs
                </label>
                <label className="seg-opt">
                  <input
                    type="radio"
                    name="discmode"
                    checked={discountMode === 'PCT'}
                    disabled={customTotalRupees != null}
                    onChange={() => setDiscountMode('PCT')}
                  />
                  %
                </label>
              </div>
            </div>
          </div>

          <div className="field" style={{ marginBottom: 12 }}>
            <label>{t('pos.customTotal')}</label>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <input
                className="input jp-num"
                style={{ flex: 1 }}
                value={customTotalRupees ?? ''}
                placeholder={t('pos.customTotalPh')}
                onChange={(e) => {
                  const v = e.target.value.trim();
                  setCustomTotalRupees(v === '' ? null : parseNum(v));
                }}
              />
              {customTotalRupees != null && (
                <button className="btn btn-ghost" onClick={() => setCustomTotalRupees(null)}>
                  {t('pos.clear')}
                </button>
              )}
            </div>
          </div>

          <div style={{ height: 1, background: 'var(--color-divider)', margin: '12px 0' }} />

          {saleAdjustmentPaisa !== 0 && (
            <Row
              label={saleAdjustmentPaisa < 0 ? t('pos.discountApplied') : t('pos.surcharge')}
              value={rs(saleAdjustmentPaisa)}
            />
          )}
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'baseline',
              gap: 10,
              marginTop: 6,
            }}
          >
            <span style={{ fontSize: 12, opacity: 0.6 }}>{t('pos.payable')}</span>
            <span
              className="jp-num"
              style={{ fontFamily: 'var(--font-heading)', fontSize: 26, textAlign: 'end' }}
            >
              {rs(finalPayable)}
            </span>
          </div>
          <div style={{ fontSize: 11, opacity: 0.55, marginTop: 4, lineHeight: 1.45 }}>
            {t('pos.estimateNote')}
          </div>

          {creditNeedsCustomer && (
            <div
              style={{
                marginTop: 9,
                padding: '8px 11px',
                borderRadius: 12,
                fontSize: 11.5,
                lineHeight: 1.45,
                background: 'color-mix(in srgb, var(--color-accent) 16%, transparent)',
                border: '1px solid color-mix(in srgb, var(--color-accent) 45%, transparent)',
              }}
            >
              {t('pos.creditNeedsCustomer')}
            </div>
          )}

          {discountOverLimit && (
            <div
              style={{
                marginTop: 9,
                padding: '8px 11px',
                borderRadius: 12,
                fontSize: 11.5,
                lineHeight: 1.45,
                background: 'color-mix(in srgb, var(--color-accent) 16%, transparent)',
                border: '1px solid color-mix(in srgb, var(--color-accent) 45%, transparent)',
              }}
            >
              {t('pos.discountOverLimit', {
                pct: capPct,
                role: session?.role ?? '',
              })}
            </div>
          )}

          <div style={{ height: 1, background: 'var(--color-divider)', margin: '12px 0' }} />

          {/* Who the bill is for. Only needed for credit, but useful on any bill
              so the sale shows up in that customer's history. */}
          <div className="field" style={{ marginBottom: 12 }}>
            <label>{t('pos.customer')}</label>
            <Select
              showSearch
              allowClear
              value={customerId ?? undefined}
              onChange={(v) => setCustomerId(v ?? null)}
              placeholder={t('pos.walkIn')}
              style={{ width: '100%' }}
              optionFilterProp="label"
              options={(customers.data ?? []).map((c) => ({ value: c.id, label: c.name }))}
              notFoundContent={
                <div style={{ padding: 8 }}>
                  <input
                    className="input"
                    value={newCustomer}
                    placeholder={t('pos.newCustomerPh')}
                    onChange={(e) => setNewCustomer(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && newCustomer.trim()) {
                        addCustomer.mutate(newCustomer.trim());
                      }
                    }}
                    style={{ width: '100%' }}
                  />
                  <div style={{ fontSize: 11, opacity: 0.6, marginTop: 6 }}>
                    {t('pos.newCustomerHint')}
                  </div>
                </div>
              }
            />
            {customerId != null && owedPaisa > 0 && (
              <div style={{ fontSize: 11.5, marginTop: 6, opacity: 0.75 }}>
                {t('pos.alreadyOwes', { amount: rs(owedPaisa) })}
              </div>
            )}
          </div>

          {/* Payments */}
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              marginBottom: 8,
            }}
          >
            <span className="jp-kicker">{t('pos.payments')}</span>
            <button
              className="btn btn-ghost"
              style={{ fontSize: 12 }}
              onClick={() => {
                setPaymentsTouched(false);
                setPayments([{ key: 1, method: 'CASH', rupees: finalPayable / 100 }]);
              }}
            >
              {t('pos.payExact')}
            </button>
          </div>

          {payments.map((p) => (
            <div
              key={p.key}
              style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 8 }}
            >
              <Select
                style={{ width: 118 }}
                value={p.method}
                onChange={(v) => {
                  setPaymentsTouched(true);
                  setPayments((ps) => ps.map((x) => (x.key === p.key ? { ...x, method: v } : x)));
                }}
                options={METHODS.map((m) => ({ value: m, label: m }))}
              />
              <input
                className="input jp-num"
                style={{ flex: 1 }}
                value={p.rupees || ''}
                placeholder="0"
                onChange={(e) => {
                  setPaymentsTouched(true);
                  const v = parseNum(e.target.value);
                  setPayments((ps) => ps.map((x) => (x.key === p.key ? { ...x, rupees: v } : x)));
                }}
              />
              {payments.length > 1 && (
                <button
                  className="btn btn-ghost"
                  aria-label={t('pos.removePayment')}
                  onClick={() => {
                    setPaymentsTouched(true);
                    setPayments((ps) => ps.filter((x) => x.key !== p.key));
                  }}
                >
                  ✕
                </button>
              )}
            </div>
          ))}

          <button
            className="btn btn-secondary"
            style={{ fontSize: 12.5 }}
            onClick={() => {
              setPaymentsTouched(true);
              setPayments((ps) => [...ps, { key: keyCounter, method: 'CARD', rupees: 0 }]);
              setKeyCounter((k) => k + 1);
            }}
          >
            {t('pos.splitPayment')}
          </button>

          <div style={{ height: 1, background: 'var(--color-divider)', margin: '12px 0' }} />
          <Row label={t('pos.paid')} value={rs(paid)} />

          {/* The counter must land on the payable exactly — say by how much it
              is out, rather than only refusing. */}
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: 10,
              marginTop: 9,
            }}
          >
            <span className={remaining === 0 ? 'tag tag-accent-2' : 'tag tag-accent'} style={{ fontSize: 11.5 }}>
              {remaining === 0
                ? 'Payments match the payable exactly'
                : remaining > 0
                  ? 'Short by'
                  : 'Over by'}
            </span>
            {remaining !== 0 && (
              <span
                className="jp-num"
                style={{ fontFamily: 'var(--font-heading)', fontSize: 17 }}
              >
                {rs(Math.abs(remaining))}
              </span>
            )}
          </div>
        </div>

        <div style={{ padding: '14px 22px 18px' }}>
          <button
            className="btn btn-primary btn-block"
            style={{ height: 48, fontSize: 16 }}
            disabled={!canCheckout || checkout.isPending}
            onClick={() => checkout.mutate()}
          >
            {checkout.isPending ? <Spin size="small" /> : `${t('pos.checkout')} · F9`}
          </button>
          <div style={{ fontSize: 11, opacity: 0.55, textAlign: 'center', marginTop: 7 }}>
            {cart.length === 0
              ? t('pos.hintAddItem')
              : creditNeedsCustomer
                ? t('pos.hintCreditBlocked')
                : discountOverLimit
                  ? t('pos.hintDiscountBlocked')
                  : t('pos.hintExactPayment')}
          </div>
        </div>
      </div>

      <Receipt invoiceId={receiptId} open={receiptId != null} onClose={() => setReceiptId(null)} />
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div
      className="jp-num"
      style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12.5, padding: '3px 0' }}
    >
      <span style={{ opacity: 0.65 }}>{label}</span>
      <span>{value}</span>
    </div>
  );
}
