import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useSession } from '../../app/session.js';
import { Brand, GateShell } from './GateShell.js';

/** Sign-in gate. One PC sits on the counter and three people share it, so the
 * PIN goes in on a keypad big enough to hit without looking — and the username
 * is typed once, then remembered between locks. */
export function LoginScreen() {
  const { t } = useTranslation();
  const { login } = useSession();
  const [username, setUsername] = useState('owner');
  const [pin, setPin] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const submit = async (secret: string) => {
    if (!username.trim()) {
      setError('Enter a username.');
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      await login(username.trim(), secret);
    } catch {
      setError(t('login.error'));
      setPin('');
    } finally {
      setSubmitting(false);
    }
  };

  const press = (key: string) => {
    if (submitting) return;
    if (key === 'del') {
      setPin((p) => p.slice(0, -1));
      setError(null);
      return;
    }
    if (key === 'ok') {
      void submit(pin);
      return;
    }
    setPin((p) => (p.length >= 12 ? p : p + key));
    setError(null);
  };

  // The counter uses the number row as much as the on-screen pad.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement && e.target.type === 'text') return;
      if (/^[0-9]$/.test(e.key)) press(e.key);
      else if (e.key === 'Backspace') press('del');
      else if (e.key === 'Enter') press('ok');
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const keys = ['1', '2', '3', '4', '5', '6', '7', '8', '9', 'del', '0', 'ok'];

  return (
    <GateShell>
      <div
        style={{
          width: 880,
          maxWidth: '100%',
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))',
          gap: 30,
          alignItems: 'center',
        }}
      >
        <div>
          <Brand style={{ marginBottom: 18 }} />
          <h2 style={{ margin: '0 0 8px', color: 'var(--color-bg)' }}>{t('login.heading')}</h2>
          <p style={{ fontSize: 13.5, opacity: 0.7, maxWidth: 380 }}>
            One PC, three people behind the counter. The screen locks itself so a salesman never
            posts under the owner’s name. Type who you are and enter the PIN.
          </p>

          <div className="field jp-on-ink" style={{ maxWidth: 300, marginTop: 14 }}>
            <label>{t('login.username')}</label>
            <input
              className="input"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              autoComplete="username"
              autoFocus
            />
          </div>

          {error && (
            <div
              style={{
                marginTop: 14,
                background: 'color-mix(in srgb, var(--color-accent-500) 22%, transparent)',
                border: '1px solid color-mix(in srgb, var(--color-accent-400) 45%, transparent)',
                borderRadius: 16,
                padding: '10px 14px',
                fontSize: 12.5,
                color: 'var(--color-accent-300)',
                maxWidth: 360,
              }}
            >
              {error}
            </div>
          )}

          <div style={{ fontSize: 11.5, opacity: 0.45, marginTop: 14, maxWidth: 360 }}>
            {t('login.hint')}
          </div>
        </div>

        <div
          style={{
            background: 'color-mix(in srgb, var(--color-bg) 7%, transparent)',
            borderRadius: 28,
            padding: 22,
          }}
        >
          <div style={{ textAlign: 'center', marginBottom: 16 }}>
            <div
              style={{
                fontSize: 11,
                letterSpacing: '.12em',
                textTransform: 'uppercase',
                opacity: 0.55,
              }}
            >
              {t('login.pin')}
            </div>
            <div
              className="jp-num"
              style={{ fontSize: 32, letterSpacing: '.34em', marginTop: 6, minHeight: 42 }}
            >
              {pin ? '•'.repeat(pin.length) : <span style={{ opacity: 0.35 }}>○○○○</span>}
            </div>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 9 }}>
            {keys.map((k) => (
              <button
                key={k}
                className="jp-key"
                disabled={submitting}
                onClick={() => press(k)}
                aria-label={k === 'del' ? 'Delete' : k === 'ok' ? t('login.submit') : k}
              >
                {k === 'del' ? '⌫' : k === 'ok' ? t('login.submit') : k}
              </button>
            ))}
          </div>
        </div>
      </div>
    </GateShell>
  );
}
