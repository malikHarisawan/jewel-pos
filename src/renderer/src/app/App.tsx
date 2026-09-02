import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App as AntApp, ConfigProvider, Spin } from 'antd';
import { useTranslation } from 'react-i18next';
import { HashRouter, Routes, Route, Navigate } from 'react-router';
import { SessionProvider, useSession } from './session.js';
import { AppShell } from './AppShell.js';
import { LoginScreen } from '../features/auth/LoginScreen.js';
import { ForceChangePinScreen } from '../features/auth/ForceChangePinScreen.js';
import { Dashboard } from '../features/dashboard/Dashboard.js';
import { ItemListScreen } from '../features/items/ItemListScreen.js';
import { ItemFormScreen } from '../features/items/ItemFormScreen.js';
import { StockScreen } from '../features/stock/StockScreen.js';
import { RatesScreen } from '../features/rates/RatesScreen.js';
import { PosScreen } from '../features/pos/PosScreen.js';
import { SalesScreen } from '../features/sales/SalesScreen.js';
import { KarigarScreen } from '../features/karigar/KarigarScreen.js';
import { SettingsScreen } from '../features/settings/SettingsScreen.js';
import { LicenseGate } from '../features/license/LicenseGate.js';
import { isRtl } from '../i18n/index.js';
import { antdTheme } from './theme.js';

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
});

function Gate() {
  const { session, loading } = useSession();
  if (loading)
    return (
      <div style={{ minHeight: '100vh', background: 'var(--jp-desk)', display: 'grid', placeItems: 'center' }}>
        <Spin size="large" />
      </div>
    );
  if (!session) return <LoginScreen />;
  // A handed-out PIN (seeded default or admin reset) blocks the whole app until
  // it is replaced — otherwise a shipped machine keeps the published password.
  if (session.mustChangePin) return <ForceChangePinScreen />;
  return (
    <Routes>
      <Route element={<AppShell />}>
        <Route index element={<Dashboard />} />
        <Route path="items" element={<ItemListScreen />} />
        <Route path="items/new" element={<ItemFormScreen />} />
        <Route path="items/:id" element={<ItemFormScreen />} />
        <Route path="stock" element={<StockScreen />} />
        <Route path="rates" element={<RatesScreen />} />
        <Route path="pos" element={<PosScreen />} />
        <Route path="sales" element={<SalesScreen />} />
        <Route path="karigar" element={<KarigarScreen />} />
        <Route path="settings" element={<SettingsScreen />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}

export function App() {
  const { i18n } = useTranslation();
  const direction = isRtl(i18n.language) ? 'rtl' : 'ltr';

  return (
    <ConfigProvider direction={direction} theme={antdTheme}>
      <AntApp>
        <QueryClientProvider client={queryClient}>
          <LicenseGate>
            <SessionProvider>
              <HashRouter>
                <Gate />
              </HashRouter>
            </SessionProvider>
          </LicenseGate>
        </QueryClientProvider>
      </AntApp>
    </ConfigProvider>
  );
}
