import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../lib/api.js';
import { useSession } from '../../app/session.js';
import { Brand, GateShell } from './GateShell.js';

/** Sign-in gate. One PC sits on the counter and three people share it, so the
 * PIN can be tapped on a keypad big enough to hit without looking, OR simply
 * typed — a real password field holds focus, so the number row works the way
 * anyone signing in expects. The username is typed once and stays between
 * locks. */
export function LoginScreen() {
  const { t } = useTranslation();
  const { login } = useSession();
  const [username, setUsername] = useState('owner');
  const [pin, setPin] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const pinRef = useRef<HTMLInputElement>(null);

  // Only print the factory credentials while they still work. Once the owner
  // picks their own PIN the hint would be naming a PIN that fails, which reads
  // as the app being broken. Asked of the database, never assumed here.
  const factory = useQuery({
    queryKey: ['auth', 'factoryPin'],
    queryFn: () => api['auth.factoryPin']({}),
    staleTime: 0,
  });

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

  // Focus the PIN box on arrival: the counter's first keystroke should land on
  // the PIN, not the username, which is already filled in from last time.
  useEffect(() => {
    pinRef.current?.focus();
  }, []);

  /**
   * Typing anywhere that is NOT a text box still drives the pad, so a digit
   * pressed while focus sits on a keypad button (after a tap) is not swallowed.
   * When the PIN field itself has focus its own onChange handles the key, so
   * this deliberately ignores it — otherwise every digit would register twice.
   */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      const tag = el?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || el?.isContentEditable) return;
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

          {factory.data?.anyDefaultPin && (
            <div style={{ fontSize: 11.5, opacity: 0.45, marginTop: 14, maxWidth: 360 }}>
              {t('login.hint', { username: factory.data.username ?? 'owner' })}
            </div>
          )}
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
            {/* A real password input, not a display div: it can be focused and
                typed into, works with the on-screen pad through the same state,
                and keeps the PIN masked either way. */}
            <input
              ref={pinRef}
              className="jp-num"
              type="password"
              inputMode="numeric"
              autoComplete="current-password"
              aria-label={t('login.pin')}
              value={pin}
              disabled={submitting}
              placeholder="••••"
              onChange={(e) => {
                // Digits only, so a stray letter cannot silently become part of
                // a PIN the user then cannot reproduce.
                setPin(e.target.value.replace(/\D/g, '').slice(0, 12));
                setError(null);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  void submit(pin);
                }
              }}
              style={{
                width: '100%',
                marginTop: 6,
                minHeight: 42,
                background: 'transparent',
                border: 0,
                borderBottom: '1px solid color-mix(in srgb, var(--color-bg) 30%, transparent)',
                color: 'var(--color-bg)',
                fontSize: 32,
                letterSpacing: '.34em',
                textAlign: 'center',
                outline: 'none',
                fontFamily: 'inherit',
              }}
            />
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 9 }}>
            {keys.map((k) => (
              <button
                key={k}
                className="jp-key"
                type="button"
                disabled={submitting}
                // Keep focus in the PIN box so tapping the pad and typing can be
                // mixed freely in one sign-in.
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => {
                  press(k);
                  pinRef.current?.focus();
                }}
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
