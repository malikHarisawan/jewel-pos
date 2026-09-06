/** Shown when a screen refilled itself from a previous visit. Restoring work
 * silently is worse than losing it — you cannot tell stale values from ones you
 * just typed — so the screen says so, and offers one click to start over. */
import { useTranslation } from 'react-i18next';

export function DraftBanner({ onDiscard }: { onDiscard: () => void }) {
  const { t } = useTranslation();
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        marginBottom: 14,
        padding: '9px 14px',
        borderRadius: 14,
        fontSize: 12.5,
        background: 'color-mix(in srgb, var(--color-accent-400) 16%, transparent)',
        border: '1px solid color-mix(in srgb, var(--color-accent-500) 40%, transparent)',
      }}
    >
      <span>{t('common.draftRestored')}</span>
      <button
        onClick={onDiscard}
        style={{
          marginInlineStart: 'auto',
          flex: 'none',
          whiteSpace: 'nowrap',
          fontSize: 12,
          fontFamily: 'inherit',
          color: 'var(--color-accent-700)',
          fontWeight: 500,
          border: 0,
          background: 'transparent',
          padding: 0,
          textDecoration: 'underline',
          cursor: 'pointer',
        }}
      >
        {t('common.startFresh')}
      </button>
    </div>
  );
}
