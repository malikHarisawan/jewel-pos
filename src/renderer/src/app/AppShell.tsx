import { useEffect, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { Outlet, useNavigate, useLocation } from 'react-router';
import { useSession } from './session.js';
import { Logo } from './Logo.js';
import { useIdleLock } from './useIdleLock.js';
import { api } from '../lib/api.js';
import { windowControls } from '../lib/windowControls.js';
import { formatPKR, TOLA_MG, MG_PER_GRAM } from '../../../shared/units/index.js';
import type { Role } from '../../../shared/domain/enums.js';

/** Sidebar entries. `roles` mirrors the channel guards in the contract — a
 * salesman may only reach the POS, so the rest are shown locked rather than
 * hidden, which is how the counter staff learn the app exists. */
interface NavEntry {
  key: string;
  path: string;
  labelKey: string;
  /** Sidebar shortcut. Absent when no safe key is left — F9 finalises a sale in
   * the POS and F10-F12 belong to Windows. */
  fkey?: string;
  /** 24x24 stroke icon path. */
  d: string;
  roles: Role[];
}

const NAV: NavEntry[] = [
  {
    key: 'dashboard',
    path: '/',
    labelKey: 'nav.dashboard',
    fkey: 'F1',
    d: 'M4 3h5a1 1 0 0 1 1 1v7a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1M15 3h5a1 1 0 0 1 1 1v4a1 1 0 0 1-1 1h-5a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1M15 12h5a1 1 0 0 1 1 1v7a1 1 0 0 1-1 1h-5a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1M4 15h5a1 1 0 0 1 1 1v4a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-4a1 1 0 0 1 1-1',
    roles: ['OWNER', 'MANAGER'],
  },
  {
    key: 'items',
    path: '/items',
    labelKey: 'nav.items',
    fkey: 'F2',
    d: 'm7.5 4.27 9 5.15M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16zm-9 5.5L3.3 7.44M12 22V12',
    roles: ['OWNER', 'MANAGER'],
  },
  {
    key: 'stock',
    path: '/stock',
    labelKey: 'nav.stock',
    fkey: 'F3',
    d: 'M12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 1.66 0l8.58-3.9a1 1 0 0 0 0-1.83zM2 12a1 1 0 0 0 .58.91l8.6 3.91a2 2 0 0 0 1.65 0l8.58-3.9A1 1 0 0 0 22 12M2 17a1 1 0 0 0 .58.91l8.6 3.91a2 2 0 0 0 1.65 0l8.58-3.9A1 1 0 0 0 22 17',
    roles: ['OWNER', 'MANAGER'],
  },
  {
    key: 'rates',
    path: '/rates',
    labelKey: 'nav.rates',
    fkey: 'F4',
    d: 'M16 7h6v6M22 7l-8.5 8.5-5-5L2 17',
    roles: ['OWNER', 'MANAGER'],
  },
  {
    key: 'pos',
    path: '/pos',
    labelKey: 'nav.pos',
    fkey: 'F5',
    d: 'M9 21a1 1 0 1 1-2 0 1 1 0 0 1 2 0M20 21a1 1 0 1 1-2 0 1 1 0 0 1 2 0M2 2h2l2.66 12.42a2 2 0 0 0 2 1.58h9.78a2 2 0 0 0 1.95-1.57l1.65-7.43H5.12',
    roles: ['OWNER', 'MANAGER', 'SALESMAN'],
  },
  {
    key: 'sales',
    path: '/sales',
    labelKey: 'nav.sales',
    fkey: 'F6',
    d: 'M14 2v4a2 2 0 0 0 2 2h4M15 2H8a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h9a2 2 0 0 0 2-2V6zM10 9h1M10 13h5M10 17h5',
    roles: ['OWNER', 'MANAGER'],
  },
  {
    key: 'credit',
    path: '/credit',
    labelKey: 'nav.credit',
    fkey: 'F7',
    d: 'M12 2v20M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6',
    roles: ['OWNER', 'MANAGER'],
  },
  {
    key: 'karigar',
    path: '/karigar',
    labelKey: 'nav.karigar',
    fkey: 'F8',
    d: 'm15 12-8.5 8.5a2.12 2.12 0 1 1-3-3L12 9M17.64 15 22 10.64M20.91 11.7l-1.25-1.25c-.6-.6-.93-1.4-.93-2.25v-.86L16.01 4.6a5.56 5.56 0 0 0-3.94-1.64H9l.92.82A6.18 6.18 0 0 1 12 8.4v1.56l2 2h2.47z',
    roles: ['OWNER', 'MANAGER'],
  },
  {
    key: 'settings',
    path: '/settings',
    labelKey: 'nav.settings',
    d: 'M21 4h-7M10 4H3M21 12h-9M8 12H3M21 20h-5M12 20H3M14 2v4M8 10v4M16 18v4',
    roles: ['OWNER', 'MANAGER'],
  },
];

/** Minimise / maximise / close, drawn in the app's own palette so the window
 * chrome matches the shell instead of sitting above it as a grey OS strip. */
function WindowButtons() {
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    const wc = windowControls;
    if (!wc) return;
    void wc.isMaximized().then(setMaximized);
    return wc.onStateChange((s) => setMaximized(s.maximized));
  }, []);

  if (!windowControls) return null;

  const btn = (
    label: string,
    onClick: () => void,
    path: ReactNode,
    danger = false,
  ) => (
    <button
      key={label}
      className={danger ? 'jp-winbtn jp-winbtn-close' : 'jp-winbtn'}
      onClick={onClick}
      title={label}
      aria-label={label}
    >
      <svg width="11" height="11" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.4">
        {path}
      </svg>
    </button>
  );

  return (
    <div className="jp-nodrag" style={{ display: 'flex', gap: 4, marginInlineStart: 4 }}>
      {btn('Minimise', () => windowControls!.minimize(), <path d="M2 6h8" />)}
      {btn(
        maximized ? 'Restore' : 'Maximise',
        () => windowControls!.toggleMaximize(),
        maximized ? (
          <>
            <rect x="2" y="4" width="6" height="6" />
            <path d="M4 4V2h6v6H8" />
          </>
        ) : (
          <rect x="2.5" y="2.5" width="7" height="7" />
        ),
      )}
      {btn('Close', () => windowControls!.close(), <path d="M3 3l6 6M9 3l-6 6" />, true)}
    </div>
  );
}

function LockIcon({ size = 13 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.4"
      strokeLinecap="round"
    >
      <path d="M5 11h14a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2M7 11V7a5 5 0 0 1 10 0v4" />
    </svg>
  );
}

/** App chrome: title bar, sidebar, status bar, filling the window edge to edge.
 * Screens render into the Outlet and supply their own padding. */
export function AppShell() {
  const { t } = useTranslation();
  const { session, logout } = useSession();
  const navigate = useNavigate();
  const location = useLocation();

  const role = (session?.role ?? 'SALESMAN') as Role;

  const settings = useQuery({ queryKey: ['settings'], queryFn: () => api['settings.get']({}) });
  const rates = useQuery({ queryKey: ['rates', 'latest'], queryFn: () => api['rates.latest']({}) });
  const license = useQuery({ queryKey: ['license', 'status'], queryFn: () => api['license.status']({}) });

  const active =
    NAV.slice(1).find((n) => location.pathname.startsWith(n.path))?.key ?? 'dashboard';

  // Lock back to sign-in after the configured idle time. Only meaningful once
  // signed in, which is the only state this shell renders in.
  const idleMinutes = Number(settings.data?.idle_lock_minutes);
  useIdleLock(idleMinutes, () => void logout());

  // F-keys jump between screens, the way the counter staff drive a POS. Guarded
  // by role so a salesman's F2 does not land on a screen the IPC will refuse.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const entry = NAV.find((n) => n.fkey != null && n.fkey === e.key);
      if (!entry) return;
      e.preventDefault();
      if (entry.roles.includes(role)) navigate(entry.path);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [navigate, role]);

  // Settings arrive as the raw snake_case string map the settings table stores.
  const tolaMg = Number(settings.data?.tola_mg) || TOLA_MG;
  const rateChips = (rates.data ?? [])
    .filter((r) => r.ratePaisaPerGram != null)
    .slice(0, 4)
    .map((r) => ({
      label: r.label,
      perTola: formatPKR(Math.round((r.ratePaisaPerGram! * tolaMg) / MG_PER_GRAM)),
    }));

  const lic = license.data;
  const trialLabel =
    lic && lic.status === 'TRIAL'
      ? `Trial · ${lic.daysLeft} day${lic.daysLeft === 1 ? '' : 's'} left`
      : lic && lic.status === 'GRACE'
        ? `Grace · ${lic.daysLeft} day${lic.daysLeft === 1 ? '' : 's'} left`
        : null;

  return (
    /* The shell fills the window edge to edge. It used to float on the desk
       background as an inset, rounded card, which cost ~68px of vertical room
       and capped the width at 1600 — on a counter monitor that is a wasted
       border around the only thing on screen. The window frame is now the
       app's own chrome, so the card had nothing left to sit in. */
    <div
      style={{
        height: '100vh',
        display: 'flex',
        fontFamily: 'var(--font-body)',
        color: 'var(--color-text)',
      }}
    >
      <div
        className="jp-shell"
        style={{
          flex: 1,
          minWidth: 0,
          display: 'flex',
          flexDirection: 'column',
          background: 'var(--color-bg)',
          overflow: 'hidden',
          position: 'relative',
        }}
      >
        {/* ══ title bar ══ */}
        {/* Also the window's drag handle now that the frame is gone. Every
            interactive child opts back out with `jp-nodrag`. */}
        <div
          className="jp-noprint jp-titlebar"
          onDoubleClick={() => windowControls?.toggleMaximize()}
          style={{
            height: 44,
            flex: 'none',
            display: 'flex',
            alignItems: 'center',
            gap: 14,
            padding: '0 8px 0 14px',
            background: 'var(--jp-ink)',
            color: 'var(--jp-on-ink)',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 9, whiteSpace: 'nowrap' }}>
            <Logo size={22} />
            <div style={{ fontFamily: 'var(--font-heading)', fontSize: 14, letterSpacing: '.01em' }}>
              {t('app.title')}
            </div>
          </div>
          <div
            style={{
              width: 1,
              height: 18,
              background: 'color-mix(in srgb, var(--color-bg) 22%, transparent)',
              flex: 'none',
            }}
          />
          <div style={{ fontSize: 12.5, opacity: 0.72, whiteSpace: 'nowrap' }}>
            {settings.data?.shop_name ?? ''}
          </div>

          <div
            style={{
              marginInlineStart: 'auto',
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              whiteSpace: 'nowrap',
            }}
          >
            {trialLabel && (
              <button
                className="jp-nodrag"
                onClick={() => navigate('/settings')}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 7,
                  border: '1px solid color-mix(in srgb, var(--color-accent-400) 50%, transparent)',
                  background: 'color-mix(in srgb, var(--color-accent-500) 18%, transparent)',
                  color: 'var(--color-accent-300)',
                  fontSize: 11.5,
                  padding: '4px 11px',
                  borderRadius: 999,
                  cursor: 'pointer',
                }}
              >
                <span
                  style={{
                    width: 6,
                    height: 6,
                    borderRadius: 999,
                    background: 'var(--color-accent-400)',
                    display: 'block',
                  }}
                />
                {trialLabel}
              </button>
            )}
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                fontSize: 12,
                background: 'color-mix(in srgb, var(--color-bg) 10%, transparent)',
                padding: '4px 5px 4px 11px',
                borderRadius: 999,
              }}
            >
              <span>{session?.displayName}</span>
              <span
                style={{
                  fontSize: 10,
                  letterSpacing: '.08em',
                  textTransform: 'uppercase',
                  background: 'var(--color-accent)',
                  color: 'var(--jp-ink)',
                  padding: '2px 8px',
                  borderRadius: 999,
                }}
              >
                {role}
              </span>
            </div>
            <button
              className="jp-nodrag"
              onClick={() => void logout()}
              title={t('common.logout')}
              aria-label={t('common.logout')}
              style={{
                width: 26,
                height: 26,
                borderRadius: 999,
                border: '1px solid color-mix(in srgb, var(--jp-on-ink) 28%, transparent)',
                background: 'transparent',
                color: 'var(--jp-on-ink)',
                cursor: 'pointer',
                display: 'grid',
                placeItems: 'center',
              }}
            >
              <LockIcon />
            </button>

            <WindowButtons />
          </div>
        </div>

        <div style={{ flex: 1, display: 'flex', minHeight: 0 }}>
          {/* ══ sidebar ══ */}
          <div
            className="jp-noprint"
            style={{
              width: 224,
              flex: 'none',
              background: 'var(--jp-ink)',
              color: 'var(--jp-on-ink)',
              display: 'flex',
              flexDirection: 'column',
              padding: '14px 12px 12px',
            }}
          >
            <div
              style={{
                fontSize: 10,
                letterSpacing: '.14em',
                textTransform: 'uppercase',
                opacity: 0.5,
                padding: '0 8px 10px',
              }}
            >
              Workspace
            </div>
            <nav style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
              {NAV.map((n) => {
                const allowed = n.roles.includes(role);
                const on = active === n.key;
                return (
                  <button
                    key={n.key}
                    className="jp-nav"
                    onClick={() => allowed && navigate(n.path)}
                    disabled={!allowed}
                    aria-current={on ? 'page' : undefined}
                    title={allowed ? undefined : `${role} cannot open ${t(n.labelKey)}`}
                  >
                    <svg
                      width="17"
                      height="17"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2.75"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      style={{ flex: 'none', opacity: 0.9 }}
                    >
                      <path d={n.d} />
                    </svg>
                    <span style={{ flex: 1 }}>{t(n.labelKey)}</span>
                    <span className="jp-navkey">{n.fkey}</span>
                  </button>
                );
              })}
            </nav>

            <div style={{ marginTop: 'auto', display: 'flex', flexDirection: 'column', gap: 8 }}>
              {rateChips.length > 0 && (
                <div
                  style={{
                    background: 'color-mix(in srgb, var(--color-bg) 8%, transparent)',
                    borderRadius: 16,
                    padding: '11px 12px',
                  }}
                >
                  <div
                    style={{
                      fontSize: 9.5,
                      letterSpacing: '.13em',
                      textTransform: 'uppercase',
                      opacity: 0.55,
                      marginBottom: 5,
                    }}
                  >
                    Rate in force
                  </div>
                  {rateChips.map((r) => (
                    <div
                      key={r.label}
                      className="jp-num"
                      style={{
                        display: 'flex',
                        justifyContent: 'space-between',
                        gap: 8,
                        fontSize: 11.5,
                        padding: '2px 0',
                        opacity: 0.92,
                      }}
                    >
                      <span style={{ opacity: 0.7 }}>{r.label}</span>
                      <span>{r.perTola}</span>
                    </div>
                  ))}
                </div>
              )}
              <div
                style={{ fontSize: 10.5, opacity: 0.42, padding: '0 8px', lineHeight: 1.45 }}
              >
                Offline · single machine
                <br />
                Ledger is append-only
              </div>
            </div>
          </div>

          {/* ══ main ══ */}
          <div
            style={{
              flex: 1,
              minWidth: 0,
              display: 'flex',
              flexDirection: 'column',
              background: 'var(--color-bg)',
            }}
          >
            <Outlet />
          </div>
        </div>

        {/* ══ status bar ══ */}
        <div
          className="jp-noprint"
          style={{
            height: 30,
            flex: 'none',
            display: 'flex',
            alignItems: 'center',
            gap: 16,
            padding: '0 16px',
            background: 'var(--color-surface)',
            borderTop: '1px solid var(--color-divider)',
            fontSize: 11,
          }}
        >
          <span style={{ opacity: 0.6 }}>Offline · no internet required</span>
          <span style={{ opacity: 0.35 }}>|</span>
          <span className="jp-num" style={{ opacity: 0.6 }}>
            Money in paisa · weight in milligrams · no floating point
          </span>
          {/* The machine ID is dictated to the vendor to mint a licence, so it
              gets the monospaced face where 0/O and 1/l stay distinct. */}
          <span className="jp-mono" style={{ marginInlineStart: 'auto', opacity: 0.45 }}>
            {lic?.machineId ?? ''}
          </span>
        </div>
      </div>
    </div>
  );
}

/** Screen scaffold — the padded scroll area every routed screen sits in, with
 * the standard title / subtitle / actions header. */
export function Screen({
  title,
  subtitle,
  actions,
  children,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div style={{ flex: 1, overflow: 'auto', padding: '26px 30px 30px' }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'flex-end',
          justifyContent: 'space-between',
          gap: 20,
          marginBottom: 18,
          flexWrap: 'wrap',
        }}
      >
        <div>
          <h2 style={{ margin: '0 0 3px' }}>{title}</h2>
          {subtitle && <div style={{ fontSize: 12.5, opacity: 0.6 }}>{subtitle}</div>}
        </div>
        {actions && <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>{actions}</div>}
      </div>
      {children}
    </div>
  );
}
