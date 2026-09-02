import type { CSSProperties, ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

/** Full-screen dark ground shared by the sign-in and licence gates. Both are
 * walls in front of the app rather than screens inside it, so they drop the
 * window chrome entirely. */
export function GateShell({ children }: { children: ReactNode }) {
  return (
    <div
      className="jp-noprint"
      style={{
        minHeight: '100vh',
        background: 'var(--jp-ink)',
        color: 'var(--color-bg)',
        display: 'grid',
        placeItems: 'center',
        padding: 30,
        fontFamily: 'var(--font-body)',
      }}
    >
      {children}
    </div>
  );
}

/** The app's mark and name, as it appears on the gates and the title bar. */
export function Brand({ style, size = 30 }: { style?: CSSProperties; size?: number }) {
  const { t } = useTranslation();
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        whiteSpace: 'nowrap',
        ...style,
      }}
    >
      <div
        style={{
          width: size,
          height: size,
          borderRadius: 999,
          background: 'var(--color-accent)',
          display: 'grid',
          placeItems: 'center',
          fontFamily: 'var(--font-heading)',
          fontSize: size * 0.45,
          color: 'var(--jp-ink)',
          flex: 'none',
        }}
      >
        J
      </div>
      <span style={{ fontFamily: 'var(--font-heading)', fontSize: size * 0.66 }}>
        {t('app.title')}
      </span>
    </div>
  );
}
