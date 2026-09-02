import { useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { Alert, Spin } from 'antd';
import { api } from '../../lib/api.js';
import { ActivationScreen } from './ActivationScreen.js';

/** Top-level licensing gate. EXPIRED → activation wall (nothing else renders).
 * TRIAL/GRACE → app with a banner. LICENSED → app. Checked in main; the renderer
 * only reflects the reported status. */
export function LicenseGate({ children }: { children: ReactNode }) {
  const { t } = useTranslation();
  const license = useQuery({
    queryKey: ['license', 'status'],
    queryFn: () => api['license.status']({}),
    // Re-check periodically so a day boundary / activation elsewhere is picked up.
    refetchInterval: 60_000,
  });
  const [justActivated, setJustActivated] = useState(false);

  if (license.isLoading || !license.data) {
    return (
      <div
        style={{ minHeight: '100vh', background: 'var(--jp-desk)', display: 'grid', placeItems: 'center' }}
      >
        <Spin size="large" />
      </div>
    );
  }

  const info = license.data;

  if (info.status === 'EXPIRED' && !justActivated) {
    return (
      <ActivationScreen
        machineId={info.machineId}
        onActivated={() => {
          setJustActivated(true);
          void license.refetch();
        }}
      />
    );
  }

  // TRIAL is reported by the chip in the title bar, which is always on screen —
  // a second banner for it only steals height. GRACE means the app is days from
  // locking, so that one still gets a full-width warning.
  const banner =
    info.status === 'GRACE' ? (
      <Alert
        type="warning"
        banner
        showIcon
        message={t('license.graceBanner').replace('{{days}}', String(info.daysLeft))}
      />
    ) : null;

  return (
    <>
      {banner}
      {children}
    </>
  );
}
