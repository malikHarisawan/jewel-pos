import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { App as AntApp, Form, Input, InputNumber, Select, Spin, Switch } from 'antd';
import { api } from '../../lib/api.js';
import { useSession } from '../../app/session.js';
import { Screen } from '../../app/AppShell.js';
import { stamp } from '../../lib/format.js';
import { UsersPanel } from './UsersPanel.js';
import { ImportPanel } from './ImportPanel.js';
import { setLang, type Lang } from '../../i18n/index.js';
import { useTheme, type Theme } from '../../app/uiPrefs.js';

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
        <AppearancePanel />
        <ShopPanel canManage={canManage} />
        <DesktopPanel canManage={canManage} />
        <SalePanel canManage={canManage} />
        {isOwner && <DiscountPanel />}
        <ChangePinPanel />
        {isOwner && <BackupPanel />}
        {isOwner && <ExportPanel />}
        {/* Full width, like Users: the import preview is a stock table with the
            same columns as the Items screen, and squeezed into one grid column
            every cell wraps onto four lines — which defeats the point of a
            preview you are meant to scan. */}
        {isOwner && (
          <div style={{ gridColumn: '1 / -1' }}>
            <ImportPanel />
          </div>
        )}
        {isOwner && (
          <div style={{ gridColumn: '1 / -1' }}>
            <UsersPanel />
          </div>
        )}
      </div>
    </Screen>
  );
}

/** Language and theme. Deliberately available to every role and not stored in
 * the database: they change how this machine looks, not what the shop records,
 * so a salesman may set them and they need no permission check. */
function AppearancePanel() {
  const { t, i18n } = useTranslation();
  const { theme, setTheme } = useTheme();

  return (
    <Panel title={t('settings.language')} hint={t('settings.languageHint')}>
      <div className="seg" style={{ marginBottom: 16 }}>
        {(
          [
            ['en', 'English'],
            ['ur', 'اردو'],
          ] as [Lang, string][]
        ).map(([v, label]) => (
          <label key={v} className="seg-opt">
            <input
              type="radio"
              name="jp-lang"
              checked={i18n.language === v}
              onChange={() => setLang(v)}
            />
            {label}
          </label>
        ))}
      </div>

      <div className="jp-kicker">{t('settings.theme')}</div>
      <div style={{ fontSize: 11.5, opacity: 0.6, margin: '4px 0 10px' }}>
        {t('settings.themeHint')}
      </div>
      <div className="seg">
        {(
          [
            ['warm', t('settings.themeWarm')],
            ['light', t('settings.themeLight')],
          ] as [Theme, string][]
        ).map(([v, label]) => (
          <label key={v} className="seg-opt">
            <input
              type="radio"
              name="jp-theme"
              checked={theme === v}
              onChange={() => setTheme(v)}
            />
            {label}
          </label>
        ))}
      </div>
    </Panel>
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
        idle_lock_minutes: String(Math.max(0, Math.round(Number(v.idle_lock_minutes) || 0))),
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
        <Form.Item
          name="idle_lock_minutes"
          label={t('settings.idleLock')}
          extra={t('settings.idleLockHint')}
        >
          <InputNumber className="jp-num" min={0} max={240} step={5} style={{ width: '100%' }} />
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

/** How the app behaves on this PC: tray parking and launching with Windows.
 *
 * These save on toggle rather than behind a Save button — a switch that needs a
 * second click to take effect reads as broken. They are per-shop settings held
 * in the database, so a reinstall keeps them. */
function DesktopPanel({ canManage }: { canManage: boolean }) {
  const { message } = AntApp.useApp();
  const qc = useQueryClient();
  const settings = useSettings();

  const save = useMutation({
    mutationFn: (patch: { close_to_tray?: '0' | '1'; launch_at_startup?: '0' | '1' }) =>
      api['settings.update'](patch),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['settings'] });
      message.success('Saved');
    },
    onError: (e: Error) => message.error(e.message),
  });

  const toTray = settings.data?.close_to_tray !== '0';
  const atStartup = settings.data?.launch_at_startup === '1';

  return (
    <Panel title="This computer" hint="Applies to this PC only.">
      <Row
        label="Keep running in the tray"
        hint="Closing the window parks Jewel POS by the clock instead of shutting it down. Quit from the tray icon to close it fully."
        checked={toTray}
        disabled={!canManage || save.isPending}
        onChange={(v) => save.mutate({ close_to_tray: v ? '1' : '0' })}
      />
      <Row
        label="Start with Windows"
        hint="Opens automatically when this PC starts, parked in the tray and ready for the first sale."
        checked={atStartup}
        disabled={!canManage || save.isPending}
        onChange={(v) => save.mutate({ launch_at_startup: v ? '1' : '0' })}
      />
    </Panel>
  );
}

function Row({
  label,
  hint,
  checked,
  disabled,
  onChange,
}: {
  label: string;
  hint: string;
  checked: boolean;
  disabled: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <div
      style={{
        display: 'flex',
        gap: 14,
        alignItems: 'flex-start',
        padding: '10px 0',
        borderTop: '1px solid var(--color-divider)',
      }}
    >
      <div style={{ flex: 1 }}>
        <div style={{ fontSize: 13.5, fontWeight: 500 }}>{label}</div>
        <div style={{ fontSize: 11.5, opacity: 0.62, marginTop: 3, lineHeight: 1.5 }}>{hint}</div>
      </div>
      <Switch checked={checked} disabled={disabled} onChange={onChange} />
    </div>
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

/** Backups: what exists, take one now, and put one back.
 *
 * Restore is the only destructive action in the app, so it asks twice and says
 * plainly what will happen. A safety copy of the current database is taken
 * first, which means restoring the wrong file is itself undoable. */
function BackupPanel() {
  const { t } = useTranslation();
  const { message, modal } = AntApp.useApp();
  const qc = useQueryClient();

  const backups = useQuery({
    queryKey: ['backups'],
    queryFn: () => api['backup.list']({}),
  });

  const takeNow = useMutation({
    mutationFn: () => api['backup.now']({}),
    onSuccess: (res) => {
      if (res.ok) message.success(t('backup.taken', { name: res.name }));
      else message.error(t('backup.failed'));
      void qc.invalidateQueries({ queryKey: ['backups'] });
    },
    onError: (e: Error) => message.error(e.message),
  });

  const restore = useMutation({
    mutationFn: (name: string) => api['backup.restore']({ name }),
    onError: (e: Error) => message.error(e.message),
  });

  const confirmRestore = (name: string) => {
    modal.confirm({
      title: t('backup.confirmTitle'),
      content: t('backup.confirmBody', { name }),
      okText: t('backup.confirmOk'),
      okButtonProps: { danger: true },
      cancelText: t('common.close'),
      onOk: () => restore.mutate(name),
    });
  };

  const mb = (bytes: number) => `${(bytes / 1_048_576).toFixed(1)} MB`;

  return (
    <Panel title="Backups" hint="Taken automatically every few hours, on close, and before any upgrade.">
      <div style={{ marginBottom: 12 }}>
        <button
          className="btn btn-secondary"
          onClick={() => takeNow.mutate()}
          disabled={takeNow.isPending}
        >
          {takeNow.isPending ? <Spin size="small" /> : t('backup.takeNow')}
        </button>
      </div>

      {backups.isLoading ? (
        <Spin />
      ) : (backups.data ?? []).length === 0 ? (
        <div style={{ fontSize: 12.5, opacity: 0.6 }}>{t('backup.none')}</div>
      ) : (
        <div style={{ maxHeight: 240, overflowY: 'auto' }}>
          <table className="table jp-num" style={{ width: '100%' }}>
            <thead>
              <tr>
                <th>{t('backup.col.when')}</th>
                <th>{t('backup.col.kind')}</th>
                <th>{t('backup.col.size')}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {(backups.data ?? []).map((b) => (
                <tr key={b.name}>
                  <td style={{ fontSize: 12 }}>{stamp(b.takenAt)}</td>
                  <td style={{ fontSize: 12, opacity: 0.7 }}>{b.kind}</td>
                  <td style={{ fontSize: 12, opacity: 0.7 }}>{mb(b.sizeBytes)}</td>
                  <td>
                    <button
                      className="btn btn-ghost"
                      onClick={() => confirmRestore(b.name)}
                      disabled={restore.isPending}
                    >
                      {t('backup.restore')}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  );
}

/** Full-database CSV export.
 *
 * Sits next to Backups because both are "get my data out", but the hint keeps
 * the difference explicit: a backup is restorable and this is not. Owner-only,
 * because the dump contains every customer balance in plain text. */
function ExportPanel() {
  const { t } = useTranslation();
  const { message } = AntApp.useApp();

  const run = useMutation({
    mutationFn: () => api['export.csv']({}),
    onSuccess: (res) => {
      message.success(
        t('export.done', {
          tables: res.tables.length,
          rows: res.totalRows,
          folder: res.folder,
        }),
      );
    },
    onError: (e: Error) => message.error(e.message),
  });

  return (
    <Panel title={t('export.title')} hint={t('export.hint')}>
      <button
        className="btn btn-secondary"
        onClick={() => run.mutate()}
        disabled={run.isPending}
      >
        {run.isPending ? <Spin size="small" /> : t('export.run')}
      </button>
      <div style={{ fontSize: 11.5, opacity: 0.6, marginTop: 10 }}>{t('export.warning')}</div>
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
