import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useSession } from '../../app/session.js';
import { useQueryClient } from '@tanstack/react-query';
import { api } from '../../lib/api.js';
import { Brand, GateShell } from './GateShell.js';

/** A wall, not a screen: shown when the signed-in account is still on a PIN it
 * was handed — the seeded `owner`/`1234`, or one an owner set during a reset.
 * Until it is replaced, no app screen renders and no IPC beyond this form is
 * reachable through the UI. Signing out is the only way past it. */
export function ForceChangePinScreen() {
  const { t } = useTranslation();
  const { session, refresh, logout } = useSession();
  const qc = useQueryClient();

  const [currentSecret, setCurrentSecret] = useState('');
  const [newSecret, setNewSecret] = useState('');
  const [confirmSecret, setConfirmSecret] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const MIN_LEN = 4;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (newSecret.length < MIN_LEN) {
      setError(t('pin.tooShort', { n: MIN_LEN }));
      return;
    }
    if (newSecret !== confirmSecret) {
      setError(t('pin.mismatch'));
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      await api['users.changeOwnPin']({ currentSecret, newSecret });
      // The factory PIN is no longer live, so the sign-in hint that names it
      // must not come back from cache the next time the counter locks.
      await qc.invalidateQueries({ queryKey: ['auth', 'factoryPin'] });
      // The main process has already cleared the flag on the live session;
      // re-read it so the gate opens without a second sign-in.
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setSubmitting(false);
    }
  };

  const field = (
    label: string,
    value: string,
    onChange: (v: string) => void,
    autoFocus = false,
  ) => (
    <div className="field" style={{ marginBottom: 12 }}>
      <label style={{ color: 'var(--color-bg)', opacity: 0.72 }}>{label}</label>
      <input
        className="input jp-num"
        type="password"
        value={value}
        autoFocus={autoFocus}
        autoComplete="off"
        onChange={(ev) => {
          onChange(ev.target.value);
          setError(null);
        }}
        style={{ width: '100%', height: 44, fontSize: 16 }}
      />
    </div>
  );

  return (
    <GateShell>
      <form
        onSubmit={(e) => void submit(e)}
        style={{ width: 380, maxWidth: '100%', display: 'flex', flexDirection: 'column' }}
      >
        <Brand style={{ marginBottom: 22 }} />

        <h2 style={{ margin: '0 0 6px', color: 'var(--color-bg)', fontSize: 22 }}>
          {t('pin.forceTitle')}
        </h2>
        <div style={{ fontSize: 12.5, opacity: 0.62, marginBottom: 20, lineHeight: 1.5 }}>
          {t('pin.forceBody', { name: session?.displayName ?? '' })}
        </div>

        {field(t('settings.currentPin'), currentSecret, setCurrentSecret, true)}
        {field(t('settings.newPin'), newSecret, setNewSecret)}
        {field(t('pin.confirm'), confirmSecret, setConfirmSecret)}

        {error && (
          <div
            style={{
              fontSize: 12.5,
              color: 'var(--color-accent-300)',
              marginBottom: 12,
              lineHeight: 1.45,
            }}
          >
            {error}
          </div>
        )}

        <button
          className="btn btn-primary btn-block"
          type="submit"
          disabled={submitting}
          style={{ height: 46, fontSize: 15 }}
        >
          {submitting ? t('common.saving') : t('settings.changePin')}
        </button>

        <button
          type="button"
          onClick={() => void logout()}
          style={{
            marginTop: 14,
            background: 'transparent',
            border: 0,
            color: 'var(--color-bg)',
            opacity: 0.55,
            fontSize: 12.5,
            cursor: 'pointer',
            fontFamily: 'var(--font-body)',
          }}
        >
          {t('common.logout')}
        </button>
      </form>
    </GateShell>
  );
}
