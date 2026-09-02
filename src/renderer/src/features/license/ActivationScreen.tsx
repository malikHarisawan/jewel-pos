import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { App as AntApp } from 'antd';
import { api } from '../../lib/api.js';
import { formatMachineId } from '../../../../shared/license/format.js';
import { Brand, GateShell } from '../auth/GateShell.js';

interface Props {
  machineId: string;
  onActivated: () => void;
}

/** Hard-lock wall shown when the trial has expired. The shop reads you their
 * Machine ID over the phone; you read back a code they paste here. Activation
 * is fully offline — no call home, ever. */
export function ActivationScreen({ machineId, onActivated }: Props) {
  const { t } = useTranslation();
  const { message } = AntApp.useApp();
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const activate = async () => {
    setBusy(true);
    setError(null);
    try {
      const info = await api['license.activate']({ code: code.trim() });
      if (info.status === 'LICENSED') {
        message.success(t('license.activated'));
        onActivated();
      } else {
        setError(t('license.stillInvalid'));
      }
    } catch {
      setError(t('license.invalidCode'));
    } finally {
      setBusy(false);
    }
  };

  const copyId = () => {
    void navigator.clipboard?.writeText(machineId).then(() => message.success(t('license.copied')));
  };

  return (
    <GateShell>
      <div style={{ width: 660, maxWidth: '100%', textAlign: 'center' }}>
        <Brand style={{ justifyContent: 'center', marginBottom: 20 }} />
        <h2 style={{ margin: '0 0 8px', color: 'var(--color-bg)' }}>{t('license.expiredTitle')}</h2>
        <p style={{ fontSize: 13.5, opacity: 0.72, maxWidth: 460, margin: '0 auto 22px' }}>
          {t('license.expiredBody')}
        </p>

        <div
          className="jp-on-ink"
          style={{
            background: 'color-mix(in srgb, var(--color-bg) 7%, transparent)',
            borderRadius: 24,
            padding: 22,
            textAlign: 'start',
          }}
        >
          <div
            style={{
              fontSize: 10,
              letterSpacing: '.12em',
              textTransform: 'uppercase',
              opacity: 0.55,
              marginBottom: 6,
            }}
          >
            {t('license.yourMachineId')}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
            <div
              className="jp-num"
              style={{
                fontFamily: 'var(--font-heading)',
                fontSize: 28,
                letterSpacing: '.12em',
                color: 'var(--color-accent-300)',
                wordBreak: 'break-all',
              }}
            >
              {formatMachineId(machineId)}
            </div>
            <button
              className="btn"
              style={{
                border: '1px solid color-mix(in srgb, var(--color-bg) 28%, transparent)',
                color: 'var(--color-bg)',
              }}
              onClick={copyId}
            >
              {t('license.copy')}
            </button>
          </div>

          {error && (
            <div
              style={{
                marginTop: 16,
                background: 'color-mix(in srgb, var(--color-accent-500) 22%, transparent)',
                border: '1px solid color-mix(in srgb, var(--color-accent-400) 45%, transparent)',
                borderRadius: 16,
                padding: '10px 14px',
                fontSize: 12.5,
                color: 'var(--color-accent-300)',
              }}
            >
              {error}
            </div>
          )}

          <div style={{ display: 'flex', gap: 10, marginTop: 18, alignItems: 'flex-end', flexWrap: 'wrap' }}>
            <div className="field" style={{ flex: 1, minWidth: 260 }}>
              <label>{t('license.enterCode')}</label>
              <textarea
                className="input jp-num"
                rows={2}
                value={code}
                onChange={(e) => setCode(e.target.value)}
                placeholder={t('license.codePlaceholder')}
                style={{ letterSpacing: '.08em', borderRadius: 18, resize: 'vertical' }}
              />
            </div>
            <button
              className="btn btn-primary"
              disabled={busy || !code.trim()}
              onClick={() => void activate()}
            >
              {t('license.activate')}
            </button>
          </div>
        </div>

        <div style={{ fontSize: 11.5, opacity: 0.5, marginTop: 16 }}>
          {t('license.dataSafe')} · activation works offline, no internet needed
        </div>
      </div>
    </GateShell>
  );
}
