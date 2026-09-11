import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useParams } from 'react-router';
import { App as AntApp, Form, Input, InputNumber, Select, Spin } from 'antd';
import { api } from '../../lib/api.js';
import { useCatalog } from './useCatalog.js';
import { Screen } from '../../app/AppShell.js';
import { useStickyForm } from '../../lib/useStickyForm.js';
import { DraftBanner } from '../../lib/DraftBanner.js';
import { amount, rs, g, tola } from '../../lib/format.js';
import { priceSaleLine } from '../../../../shared/pricing/engine.js';
import {
  gramsToMg,
  mgToGrams,
  rupeesToPaisa,
  paisaToRupees,
  TOLA_MG,
} from '../../../../shared/units/index.js';
import type { TaxBase } from '../../../../shared/domain/enums.js';
import type { Api } from '../../../../shared/contracts/index.js';

interface FormValues {
  trackingMode: 'ITEM' | 'LOT';
  tagNumber?: string;
  name: string;
  productTypeId: number;
  metalId: number;
  purityId: number;
  stoneTypeId: number;
  makingTypeId: number;
  occasionId?: number | null;
  originKind: 'SUPPLIER' | 'KARIGAR' | 'IN_HOUSE' | 'OLD_GOLD';
  grossG: number;
  lessG: number;
  makingMode: 'PER_GRAM' | 'FIXED' | 'PCT_OF_METAL';
  makingRateRupees: number;
  wastagePct: number;
  hallmarkNumber?: string;
  hallmarkChargeRupees: number;
  locationId: number;
  notes?: string;
  openingPieces: number;
}

/** A rounded surface with a small uppercase title — the form's section unit. */
function Section({
  title,
  hint,
  children,
  dark = false,
}: {
  title: string;
  hint?: string;
  children: React.ReactNode;
  dark?: boolean;
}) {
  return (
    <div
      className={dark ? 'jp-on-ink' : undefined}
      style={{
        background: dark ? 'var(--jp-ink)' : 'var(--color-surface)',
        color: dark ? 'var(--color-bg)' : undefined,
        borderRadius: 24,
        padding: '18px 20px',
      }}
    >
      <div
        className={dark ? undefined : 'jp-kicker'}
        style={
          dark
            ? {
                fontSize: 10,
                letterSpacing: '.12em',
                textTransform: 'uppercase',
                color: 'var(--color-accent-400)',
              }
            : undefined
        }
      >
        {title}
      </div>
      {hint && (
        <div style={{ fontSize: 11.5, opacity: 0.6, marginTop: 4 }}>{hint}</div>
      )}
      <div style={{ marginTop: 12 }}>{children}</div>
    </div>
  );
}

const grid = (cols: string): React.CSSProperties => ({
  display: 'grid',
  gridTemplateColumns: cols,
  gap: 12,
});

/** The stored record as form values. Shared by the edit prefill and the
 * "start fresh" button, so discarding a draft lands on exactly the values the
 * form opened with. */
function prefillFrom(d: Awaited<ReturnType<Api['items.get']>>): FormValues {
  return {
    trackingMode: d.trackingMode,
    tagNumber: d.tagNumber ?? undefined,
    name: d.name,
    productTypeId: d.productTypeId,
    metalId: d.metalId,
    purityId: d.purityId,
    stoneTypeId: d.stoneTypeId,
    makingTypeId: d.makingTypeId,
    occasionId: d.occasionId,
    originKind: d.originKind,
    grossG: mgToGrams(d.grossMg),
    lessG: mgToGrams(d.lessMg),
    makingMode: d.makingMode,
    makingRateRupees:
      d.makingMode === 'PCT_OF_METAL' ? d.makingRatePaisa / 100 : paisaToRupees(d.makingRatePaisa),
    wastagePct: d.wastageBp / 100,
    hallmarkNumber: d.hallmarkNumber ?? undefined,
    hallmarkChargeRupees: paisaToRupees(d.hallmarkChargePaisa),
    locationId: d.locationId,
    notes: d.notes ?? undefined,
    openingPieces: 0,
  };
}

export function ItemFormScreen() {
  const { t } = useTranslation();
  const { id } = useParams();
  const isEdit = id != null;
  const itemId = isEdit ? Number(id) : undefined;
  const navigate = useNavigate();
  const { message } = AntApp.useApp();
  const qc = useQueryClient();
  const [form] = Form.useForm<FormValues>();
  /* Classification is collapsed when adding, where the defaults are usually
     right, and open when editing, where the existing values are the point. */
  const [showMore, setShowMore] = useState(isEdit);

  const catalog = useCatalog();
  const rates = useQuery({ queryKey: ['rates', 'latest'], queryFn: () => api['rates.latest']({}) });
  const settings = useQuery({ queryKey: ['settings'], queryFn: () => api['settings.get']({}) });
  const existing = useQuery({
    queryKey: ['items', 'get', itemId],
    queryFn: () => api['items.get']({ id: itemId! }),
    enabled: isEdit,
  });

  /* A draft per form identity: the new-item form and each edited item keep
     their own, so starting a new piece never overwrites an edit in progress. */
  const draftKey = `items.form.${isEdit ? itemId : 'new'}`;
  /* Restore only once the form has its real starting values — the catalog
     defaults, and on edit the fetched record. Refilling before that would be
     overwritten by the prefill below. */
  const sticky = useStickyForm<FormValues>(draftKey, form, {
    enabled: !catalog.isLoading && (!isEdit || existing.data != null),
  });

  // Prefill on edit.
  useEffect(() => {
    if (existing.data) form.setFieldsValue(prefillFrom(existing.data));
  }, [existing.data, form]);

  const grossG = Form.useWatch('grossG', form) ?? 0;
  const lessG = Form.useWatch('lessG', form) ?? 0;
  const purityId = Form.useWatch('purityId', form);
  const makingMode = Form.useWatch('makingMode', form) ?? 'PER_GRAM';
  const makingRate = Form.useWatch('makingRateRupees', form) ?? 0;
  const wastagePct = Form.useWatch('wastagePct', form) ?? 0;
  const hallmarkCharge = Form.useWatch('hallmarkChargeRupees', form) ?? 0;

  const netMg = Math.max(0, gramsToMg(grossG || 0) - gramsToMg(lessG || 0));
  const tolaMg = Number(settings.data?.tola_mg) || TOLA_MG;

  const rate = (rates.data ?? []).find((r) => r.purityId === purityId);
  const purityLabel = catalog.data?.purities.find((p) => p.id === purityId)?.label ?? '';

  /* Price preview. Runs the same pure engine the server prices with, so what
     the form shows is what the invoice will bill. Tax is deliberately left out
     — this is the shelf price of one piece, not a sale. */
  const preview =
    rate?.ratePaisaPerGram != null && netMg > 0
      ? priceSaleLine(
          {
            netMg,
            wastageBp: Math.round((wastagePct || 0) * 100),
            making: {
              mode: makingMode,
              ratePaisa:
                makingMode === 'PCT_OF_METAL'
                  ? Math.round((makingRate || 0) * 100)
                  : rupeesToPaisa(makingRate || 0),
            },
            stones: [],
            hallmarkChargePaisa: rupeesToPaisa(hallmarkCharge || 0),
          },
          {
            purityId: purityId!,
            metalRateId: 0,
            ratePaisaPerGram: rate.ratePaisaPerGram,
          },
          { paisa: 0 },
          { rateBp: 0, base: 'TOTAL' as TaxBase },
        )
      : null;


  const save = useMutation({
    mutationFn: async (v: FormValues) => {
      const grossMg = gramsToMg(v.grossG);
      const lessMg = gramsToMg(v.lessG || 0);
      const net = grossMg - lessMg;
      const makingRatePaisa =
        v.makingMode === 'PCT_OF_METAL'
          ? Math.round((v.makingRateRupees || 0) * 100) // percent -> bp
          : rupeesToPaisa(v.makingRateRupees || 0);

      const common = {
        name: v.name,
        productTypeId: v.productTypeId,
        metalId: v.metalId,
        purityId: v.purityId,
        stoneTypeId: v.stoneTypeId,
        makingTypeId: v.makingTypeId,
        occasionId: v.occasionId ?? null,
        originKind: v.originKind,
        grossMg,
        lessMg,
        netMg: net,
        wastageBp: Math.round((v.wastagePct || 0) * 100),
        makingMode: v.makingMode,
        makingRatePaisa,
        hallmarkNumber: v.hallmarkNumber,
        hallmarkChargePaisa: rupeesToPaisa(v.hallmarkChargeRupees || 0),
        locationId: v.locationId,
        notes: v.notes,
      };

      if (isEdit) {
        return api['items.update']({ id: itemId!, ...common });
      }
      return api['items.create']({
        ...common,
        trackingMode: v.trackingMode,
        tagNumber: v.tagNumber || undefined,
        openingPieces: v.openingPieces || 0,
      });
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['items'] });
      void qc.invalidateQueries({ queryKey: ['dashboard'] });
      // The work is on disk now, so the in-progress copy has done its job.
      sticky.clear();
      message.success(isEdit ? t('items.saved') : t('items.created'));
      navigate('/items');
    },
    onError: (e: Error) => message.error(e.message),
  });

  if (catalog.isLoading || (isEdit && existing.isLoading)) {
    return (
      <div style={{ flex: 1, display: 'grid', placeItems: 'center' }}>
        <Spin size="large" />
      </div>
    );
  }
  const c = catalog.data!;
  const opt = (rows: { id: number; name: string }[]) =>
    rows.map((r) => ({ value: r.id, label: r.name }));

  const previewRows = preview
    ? [
        {
          k: 'Metal',
          v: rs(preview.metalValuePaisa),
          s: `${g(netMg)} g × Rs ${amount(rate!.ratePaisaPerGram!)}/g (${purityLabel})`,
        },
        {
          k: 'Making',
          v: rs(preview.makingValuePaisa),
          s:
            makingMode === 'PER_GRAM'
              ? `Rs ${makingRate}/g`
              : makingMode === 'FIXED'
                ? `Rs ${makingRate} flat`
                : `${makingRate}% of metal`,
        },
        { k: 'Wastage', v: rs(preview.wastageValuePaisa), s: `${wastagePct}% of metal` },
        { k: 'Hallmark', v: rs(preview.hallmarkChargePaisa), s: 'per piece' },
      ]
    : [];

  return (
    <Screen
      title={isEdit ? `${t('items.edit')}${existing.data?.tagNumber ? ` ${existing.data.tagNumber}` : ''}` : t('items.add')}
      subtitle="Stock changes only ever happen through the ledger — the opening figure below posts one movement"
      actions={
        <>
          <button
            className="btn btn-secondary"
            onClick={() => {
              // Cancel means discard — leaving by the sidebar keeps the draft.
              sticky.clear();
              navigate('/items');
            }}
          >
            {t('common.cancel')}
          </button>
          <button
            className="btn btn-primary"
            disabled={save.isPending}
            onClick={() => form.submit()}
          >
            {t('common.save')}
          </button>
        </>
      }
    >
      {sticky.restored && (
        <DraftBanner
          onDiscard={() => {
            sticky.clear();
            /* Back to the real starting point: the blank form for a new piece,
               the stored record when editing — not merely an empty form. */
            form.resetFields();
            if (existing.data) form.setFieldsValue(prefillFrom(existing.data));
          }}
        />
      )}
      <Form<FormValues>
        form={form}
        layout="vertical"
        initialValues={{
          trackingMode: 'ITEM',
          originKind: 'IN_HOUSE',
          makingMode: 'PER_GRAM',
          lessG: 0,
          wastagePct: 0,
          makingRateRupees: 0,
          hallmarkChargeRupees: 0,
          openingPieces: 1,
          locationId: c.locations[0]?.id,
          // The server requires these; defaulting them is what lets the
          // collapsed section stay collapsed on a normal add. First entry in
          // each axis is the catalogue's own default (Gold / Plain / Handmade).
          metalId: c.metals[0]?.id,
          stoneTypeId: c.stoneTypes[0]?.id,
          makingTypeId: c.makingTypes[0]?.id,
          productTypeId: c.productTypes[0]?.id,
          // Purity is deliberately NOT defaulted. It selects the rate the piece
          // is priced from, so guessing it would misprice the shelf silently —
          // it is the one classification worth stopping the form for.
        }}
        onValuesChange={sticky.onValuesChange}
        onFinish={(v) => save.mutate(v)}
      >
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'minmax(0, 1fr) 380px',
            gap: 16,
            alignItems: 'start',
          }}
        >
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <Section title={t('items.section.identity')}>
              <div style={{ ...grid('1fr 1.6fr'), marginBottom: 12 }}>
                <Form.Item name="tagNumber" label={t('items.field.tag')} tooltip={t('items.tagHint')}>
                  <Input className="jp-num" placeholder={t('items.tagAuto')} disabled={isEdit} />
                </Form.Item>
                <Form.Item name="name" label={t('items.field.name')} rules={[{ required: true }]}>
                  <Input placeholder="e.g. Kundan bridal set" />
                </Form.Item>
              </div>
              <div style={grid('1fr 1fr 1fr')}>
                <Form.Item
                  name="productTypeId"
                  label={t('items.field.productType')}
                  rules={[{ required: true }]}
                >
                  <Select options={opt(c.productTypes)} showSearch optionFilterProp="label" />
                </Form.Item>
                <Form.Item name="purityId" label={t('items.field.purity')} rules={[{ required: true }]}>
                  <Select options={c.purities.map((p) => ({ value: p.id, label: p.label }))} />
                </Form.Item>
                <Form.Item name="locationId" label={t('items.field.location')} rules={[{ required: true }]}>
                  <Select options={c.locations.map((l) => ({ value: l.id, label: l.name }))} />
                </Form.Item>
              </div>
              {/* Classification the server requires but the counter rarely
                  changes. These carry sensible defaults, so adding a piece does
                  not mean answering six dropdowns; anyone who does care can
                  open this and set them. Kept mounted rather than unmounted so
                  the values still submit while collapsed. */}
              <button
                type="button"
                className="btn btn-ghost"
                style={{ fontSize: 12.5, padding: '4px 0' }}
                onClick={() => setShowMore((v) => !v)}
              >
                {showMore ? '− Hide details' : '+ More details'}
              </button>
              <div style={{ display: showMore ? 'block' : 'none', marginTop: 12 }}>
                <div style={grid('1fr 1fr 1fr')}>
                  <Form.Item name="metalId" label={t('items.field.metal')} rules={[{ required: true }]}>
                    <Select options={opt(c.metals)} />
                  </Form.Item>
                  <Form.Item name="stoneTypeId" label={t('items.field.stoneType')} rules={[{ required: true }]}>
                    <Select options={opt(c.stoneTypes)} />
                  </Form.Item>
                  <Form.Item name="makingTypeId" label={t('items.field.makingType')} rules={[{ required: true }]}>
                    <Select options={opt(c.makingTypes)} />
                  </Form.Item>
                </div>
                <div style={grid('1fr 1fr 1fr')}>
                  <Form.Item name="occasionId" label={t('items.field.occasion')}>
                    <Select allowClear options={opt(c.occasions)} />
                  </Form.Item>
                  <Form.Item name="originKind" label={t('items.field.origin')}>
                    <Select
                      options={[
                        { value: 'IN_HOUSE', label: t('items.origin.inHouse') },
                        { value: 'SUPPLIER', label: t('items.origin.supplier') },
                        { value: 'KARIGAR', label: t('items.origin.karigar') },
                      ]}
                    />
                  </Form.Item>
                  {!isEdit && (
                    <Form.Item name="trackingMode" label={t('items.field.trackingMode')}>
                      <Select
                        options={[
                          { value: 'ITEM', label: t('items.trackingItem') },
                          { value: 'LOT', label: t('items.trackingLot') },
                        ]}
                      />
                    </Form.Item>
                  )}
                </div>
              </div>
            </Section>

            <Section title={t('items.section.weight')}>
              <div style={{ display: 'flex', alignItems: 'flex-end', gap: 12, flexWrap: 'wrap' }}>
                <div style={{ width: 150 }}>
                  <Form.Item name="grossG" label={t('items.field.grossG')} rules={[{ required: true }]}>
                    <InputNumber className="jp-num" min={0} step={0.001} style={{ width: '100%' }} />
                  </Form.Item>
                </div>
                <div style={{ fontFamily: 'var(--font-heading)', fontSize: 22, paddingBottom: 30, opacity: 0.45 }}>
                  −
                </div>
                <div style={{ width: 170 }}>
                  <Form.Item name="lessG" label={t('items.field.less')}>
                    <InputNumber className="jp-num" min={0} step={0.001} style={{ width: '100%' }} />
                  </Form.Item>
                </div>
                <div style={{ fontFamily: 'var(--font-heading)', fontSize: 22, paddingBottom: 30, opacity: 0.45 }}>
                  =
                </div>
                <div
                  style={{
                    background: 'var(--color-accent-100)',
                    border: '1px solid var(--color-accent-300)',
                    borderRadius: 999,
                    padding: '8px 18px',
                    display: 'flex',
                    flexDirection: 'column',
                    marginBottom: 24,
                  }}
                >
                  <span
                    style={{
                      fontSize: 9.5,
                      letterSpacing: '.1em',
                      textTransform: 'uppercase',
                      color: 'var(--color-accent-700)',
                    }}
                  >
                    Net — metal priced
                  </span>
                  <span
                    className="jp-figure" style={{ fontSize: 19, color: 'var(--color-accent-800)' }}
                  >
                    {g(netMg)} g
                  </span>
                </div>
                <div className="jp-num" style={{ fontSize: 11.5, opacity: 0.55, paddingBottom: 32 }}>
                  {tola(netMg, tolaMg)} tola
                </div>
              </div>
            </Section>

            <Section title={t('items.section.charges')}>
              <div style={grid('1.2fr 1fr')}>
                <Form.Item name="makingMode" label={t('items.field.makingMode')}>
                  <Select
                    options={[
                      { value: 'PER_GRAM', label: t('items.making.perGram') },
                      { value: 'FIXED', label: t('items.making.fixed') },
                      { value: 'PCT_OF_METAL', label: t('items.making.pct') },
                    ]}
                  />
                </Form.Item>
                <Form.Item
                  name="makingRateRupees"
                  label={
                    makingMode === 'PCT_OF_METAL' ? t('items.field.makingPct') : t('items.field.makingRate')
                  }
                >
                  <InputNumber
                    className="jp-num"
                    min={0}
                    step={makingMode === 'PCT_OF_METAL' ? 0.1 : 1}
                    style={{ width: '100%' }}
                  />
                </Form.Item>
              </div>
              {/* Wastage and hallmarking apply to some pieces, not most, and
                  they default to zero. Behind the same toggle as the rest. */}
              <div style={{ display: showMore ? 'block' : 'none' }}>
                <div style={grid('1fr 1fr 1.4fr')}>
                  <Form.Item name="wastagePct" label={t('items.field.wastagePct')}>
                    <InputNumber className="jp-num" min={0} step={0.1} style={{ width: '100%' }} />
                  </Form.Item>
                  <Form.Item name="hallmarkChargeRupees" label={t('items.field.hallmarkCharge')}>
                    <InputNumber className="jp-num" min={0} step={1} style={{ width: '100%' }} />
                  </Form.Item>
                  <Form.Item name="hallmarkNumber" label={t('items.field.hallmarkNo')}>
                    <Input className="jp-num" />
                  </Form.Item>
                </div>
              </div>
            </Section>

            {!isEdit && (
              <Section
                title={t('items.section.opening')}
                hint="Posts one opening movement onto the ledger. After this, stock only moves through the ledger."
              >
                <div style={{ width: 200 }}>
                  <Form.Item
                    name="openingPieces"
                    label={t('items.field.openingPieces')}
                    tooltip={t('items.openingHint')}
                  >
                    <InputNumber className="jp-num" min={0} step={1} style={{ width: '100%' }} />
                  </Form.Item>
                </div>
              </Section>
            )}
          </div>

          {/* Price preview — the same breakdown the cart and the invoice show. */}
          <div className="jp-panel" style={{ position: 'sticky', top: 0 }}>
            <div className="jp-kicker">Price preview</div>
            <div style={{ fontSize: 11.5, opacity: 0.6, margin: '4px 0 14px' }}>
              The same breakdown the cart and the invoice use.
            </div>
            {preview ? (
              <>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 9 }}>
                  {previewRows.map((r) => (
                    <div
                      key={r.k}
                      className="jp-num"
                      style={{
                        display: 'flex',
                        justifyContent: 'space-between',
                        gap: 12,
                        alignItems: 'baseline',
                      }}
                    >
                      <span style={{ fontSize: 13 }}>
                        {r.k}
                        <br />
                        <span style={{ fontSize: 10.5, opacity: 0.5 }}>{r.s}</span>
                      </span>
                      <span style={{ fontWeight: 600, whiteSpace: 'nowrap' }}>{r.v}</span>
                    </div>
                  ))}
                </div>
                <div style={{ height: 1, background: 'var(--color-divider)', margin: '14px 0' }} />
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 10 }}>
                  <span style={{ fontSize: 12, opacity: 0.6 }}>Sells at</span>
                  <span
                    className="jp-figure" style={{ fontSize: 24, textAlign: 'end' }}
                  >
                    {rs(preview.lineTotalPaisa)}
                  </span>
                </div>
              </>
            ) : (
              <div style={{ fontSize: 12.5, opacity: 0.6, lineHeight: 1.5 }}>
                {netMg <= 0
                  ? 'Enter a gross weight to see the price.'
                  : `No ${purityLabel || 'rate'} posted today — pricing is blocked until a rate exists.`}
              </div>
            )}
            <div style={{ fontSize: 11, opacity: 0.5, marginTop: 12, lineHeight: 1.45 }}>
              Excludes sales tax, which is applied per invoice at checkout.
            </div>
          </div>
        </div>
      </Form>
    </Screen>
  );
}
