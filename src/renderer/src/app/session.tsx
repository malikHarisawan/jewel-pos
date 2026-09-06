import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { api } from '../lib/api.js';
import { clearAllScreenState } from '../lib/screenState.js';
import type { SessionDTO } from '../../../shared/contracts/index.js';

interface SessionState {
  session: SessionDTO | null;
  loading: boolean;
  login: (username: string, secret: string) => Promise<void>;
  logout: () => Promise<void>;
  /** Re-read the session from the main process. Used after a change that alters
   * the session itself (e.g. clearing the forced-PIN-change flag). */
  refresh: () => Promise<void>;
}

const SessionContext = createContext<SessionState | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<SessionDTO | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    void api['auth.me']({})
      .then(setSession)
      .finally(() => setLoading(false));
  }, []);

  const login = async (username: string, secret: string) => {
    const s = await api['auth.login']({ username, secret });
    setSession(s);
  };

  const logout = async () => {
    await api['auth.logout']({});
    // Carts, drafts and filters are per-person. The idle lock routes here too,
    // so the next person at the counter never inherits the last one's work.
    clearAllScreenState();
    setSession(null);
  };

  const refresh = async () => {
    setSession(await api['auth.me']({}));
  };

  return (
    <SessionContext.Provider value={{ session, loading, login, logout, refresh }}>
      {children}
    </SessionContext.Provider>
  );
}

export function useSession(): SessionState {
  const ctx = useContext(SessionContext);
  if (!ctx) throw new Error('useSession must be used within SessionProvider');
  return ctx;
}
