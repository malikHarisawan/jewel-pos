import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { api } from '../lib/api.js';
import type { SessionDTO } from '../../../shared/contracts/index.js';

interface SessionState {
  session: SessionDTO | null;
  loading: boolean;
  login: (username: string, secret: string) => Promise<void>;
  logout: () => Promise<void>;
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
    setSession(null);
  };

  return (
    <SessionContext.Provider value={{ session, loading, login, logout }}>
      {children}
    </SessionContext.Provider>
  );
}

export function useSession(): SessionState {
  const ctx = useContext(SessionContext);
  if (!ctx) throw new Error('useSession must be used within SessionProvider');
  return ctx;
}
