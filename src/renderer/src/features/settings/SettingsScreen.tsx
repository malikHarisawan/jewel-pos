import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { App as AntApp, Form, Input, InputNumber, Select } from 'antd';
import { api } from '../../lib/api.js';
import { useSession } from '../../app/session.js';
import { Screen } from '../../app/AppShell.js';
import { UsersPanel } from './UsersPanel.js';

/** Shop identity, tax and rounding rules, users and this user's own PIN.
 * Everything here feeds the next invoice; nothing rewrites an invoice already
 * finalised. */
export function SettingsScreen() {
  const { t } = useTranslation();
  const { session } = useSession();
  const canManage = session?.role === 'OWNER' || session?.role === 'MANAGER';
  const isOwner = session?.role === 'OWNER';

  return (
    <Screen
      title={t('nav.settings')}
      subtitle="Shop, tax and rounding rules feed every invoice. Changing them never rewrites an invoice already finalised."
    >
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(380px, 1fr))',
          gap: 16,
          alignItems: 'start',
        }}
      >
        <ShopPanel canManage={canManage} />
        <SalePanel canManage={canManage} />
        {isOwner && <DiscountPanel />}
        <ChangePinPanel />
        {isOwner && (
          <div style={{ gridColumn: '1 / -1' }}>
            <UsersPanel />
          </div>
        )}
      </div>
    </Screen>
  );
}

function useSettings() {
  return useQuery({ queryKey: ['settings'], queryFn: () => api['settings.get']({}) });
}

function Panel({
  title,
  hint,
  children,
}: {
  title: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="jp-panel">
      <div className="jp-kicker">{title}</div>
      {hint && <div style={{ fontSize: 11.5, opacity: 0.6, marginTop: 4 }}>{hint}</div>}
      <div style={{ marginTop: 12 }}>{children}</div>
    </div>
  );
}

function ShopPanel({ canManage }: { canManage: boolean }) {
  const { t } = useTranslation();
  const { message } = AntApp.useApp();
  const qc = useQueryClient();
  const settings = useSettings();
  const [form] = Form.useForm();

  useEffect(() => {
    if (settings.data) form.setFieldsValue(settings.data);
  }, [settings.data, form]);

  const save = useMutation({
    mutationFn: (v: Record<string, string>) =>
      api['settings.update']({
        shop_name: v.shop_name,
        shop_address: v.shop_address,
        shop_phone: v.shop_phone,
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['settings'] });
      message.success(t('settings.saved'));
    },
    onError: (e: Error) => message.error(e.message),
  });

  return (
    <Panel title="Shop" hint="Printed at the head of every invoice.">
      <Form layout="vertical" form={form} onFinish={(v) => save.mutate(v)} disabled={!canManage}>
        <Form.Item name="shop_name" label={t('settings.shopName')} rules={[{ required: true }]}>
          <Input />
        </Form.Item>
        <Form.Item name="shop_address" label={t('settings.shopAddress')}>
          <Input.TextArea rows={2} />
        </Form.Item>
        <Form.Item name="shop_phone" label={t('settings.shopPhone')}>
          <Input className="jp-num" />
        </Form.Item>
        {canManage && (
          <button className="btn btn-primary" type="submit" disabled={save.isPending}>
            {t('common.save')}
          </button>
        )}
      </Form>
    </Panel>
  );
}

function SalePanel({ canManage }: { canManage: boolean }) {
  const { t } = useTranslation();
  const { message } = AntApp.useApp();
  const qc = useQueryClient();
  const settings = useSettings();
  const [form] = Form.useForm();

  useEffect(() => {
    if (settings.data) {
      form.setFieldsValue({
        taxPct: Number(settings.data.tax_rate_bp) / 100,
        tax_base: settings.data.tax_base,
        invoice_round_to: settings.data.invoice_round_to,
      });
    }
  }, [settings.data, form]);

  const save = useMutation({
    mutationFn: (v: {
      taxPct: number;
      tax_base: 'TOTAL' | 'TOTAL_MINUS_METAL';
      invoice_round_to: '1' | '100';
    }) =>
      api['settings.update']({
        tax_rate_bp: String(Math.round((v.taxPct || 0) * 100)),
        tax_base: v.tax_base,
        invoice_round_to: v.invoice_round_to,
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['settings'] });
      void qc.invalidateQueries({ queryKey: ['items'] }); // pricing depends on tax
      message.success(t('settings.saved'));
    },
    onError: (e: Error) => message.error(e.message),
  });

  return (
    <Panel title="Tax & rounding" hint="Applied at checkout, per invoice.">
      <Form layout="vertical" form={form} onFinish={(v) => save.mutate(v)} disabled={!canManage}>
        <div style={{ display: 'grid', gridTemplateColumns: '.7fr 1fr', gap: 12 }}>
          <Form.Item name="taxPct" label={t('settings.taxPct')}>
            <InputNumber className="jp-num" min={0} step={0.5} style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item name="invoice_round_to" label={t('settings.rounding')}>
            <Select
              options={[
                { value: '100', label: t('settings.roundRupee') },
                { value: '1', label: t('settings.roundNone') },
              ]}
            />
          </Form.Item>
        </div>
        <Form.Item name="tax_base" label={t('settings.taxBase')}>
          <Select
            options={[
              { value: 'TOTAL_MINUS_METAL', label: t('settings.taxExemptMetal') },
              { value: 'TOTAL', label: t('settings.taxOnTotal') },
            ]}
          />
        </Form.Item>
        {canManage && (
          <button className="btn btn-primary" type="submit" disabled={save.isPending}>
            {t('common.save')}
          </button>
        )}
      </Form>
    </Panel>
  );
}

/** Discount authority. Owner-only: these ceilings are what stop a cashier from
 * discounting a bill to nothing, so a manager must not be able to raise their
 * own limit. The server enforces them regardless of what this screen shows. */
function DiscountPanel() {
  const { t } = useTranslation();
  const { message } = AntApp.useApp();
  const qc = useQueryClient();
  const settings = useSettings();
  const [form] = Form.useForm();

  useEffect(() => {
    if (settings.data) {
      form.setFieldsValue({
        max_discount_pct_salesman: Number(settings.data.max_discount_pct_salesman),
        max_discount_pct_manager: Number(settings.data.max_discount_pct_manager),
      });
    }
  }, [settings.data, form]);

  const save = useMutation({
    mutationFn: (v: { max_discount_pct_salesman: number; max_discount_pct_manager: number }) =>
      api['settings.update']({
        max_discount_pct_salesman: String(v.max_discount_pct_salesman ?? 0),
        max_discount_pct_manager: String(v.max_discount_pct_manager ?? 0),
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['settings'] });
      message.success(t('settings.saved'));
    },
    onError: (e: Error) => message.error(e.message),
  });

  return (
    <Panel
      title="Discount limits"
      hint="How far each role may cut a bill on their own. Checked at checkout — a sale past the limit is refused."
    >
      <Form layout="vertical" form={form} onFinish={(v) => save.mutate(v)}>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          <Form.Item name="max_discount_pct_salesman" label={t('settings.discountSalesman')}>
            <InputNumber className="jp-num" min={0} max={100} step={1} addonAfter="%" style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item name="max_discount_pct_manager" label={t('settings.discountManager')}>
            <InputNumber className="jp-num" min={0} max={100} step={1} addonAfter="%" style={{ width: '100%' }} />
          </Form.Item>
        </div>
        <button className="btn btn-primary" type="submit" disabled={save.isPending}>
          {t('common.save')}
        </button>
      </Form>
    </Panel>
  );
}

function ChangePinPanel() {
  const { t } = useTranslation();
  const { message } = AntApp.useApp();
  const [form] = Form.useForm();

  const change = useMutation({
    mutationFn: (v: { currentSecret: string; newSecret: string }) =>
      api['users.changeOwnPin']({ currentSecret: v.currentSecret, newSecret: v.newSecret }),
    onSuccess: () => {
      message.success(t('settings.pinChanged'));
      form.resetFields();
    },
    onError: (e: Error) => message.error(e.message),
  });

  return (
    <Panel title="My PIN" hint="Sign-in is username + PIN. Changing it takes effect at the next lock.">
      <Form layout="vertical" form={form} onFinish={(v) => change.mutate(v)}>
        <Form.Item name="currentSecret" label={t('settings.currentPin')} rules={[{ required: true }]}>
          <Input.Password className="jp-num" autoComplete="current-password" />
        </Form.Item>
        <Form.Item name="newSecret" label={t('settings.newPin')} rules={[{ required: true, min: 4 }]}>
          <Input.Password className="jp-num" autoComplete="new-password" />
        </Form.Item>
        <button className="btn btn-primary" type="submit" disabled={change.isPending}>
          {t('settings.changePin')}
        </button>
      </Form>
    </Panel>
  );
}
