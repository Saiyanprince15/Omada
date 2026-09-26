import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import * as api from './api';
import type { User } from '../types';

interface AuthContextValue {
  user: User | null;
  loading: boolean;
  refreshUser: () => Promise<void>;
  signIn: (email: string, password: string) => Promise<void>;
  signUp: (displayName: string, email: string, password: string) => Promise<void>;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(Boolean(api.getAccessToken()));

  const refreshUser = async () => {
    if (!api.getAccessToken()) {
      setUser(null);
      setLoading(false);
      return;
    }
    try {
      setUser(await api.getMe());
    } catch {
      api.clearTokens();
      setUser(null);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void refreshUser();
  }, []);

  const value = useMemo<AuthContextValue>(() => ({
    user,
    loading,
    refreshUser,
    async signIn(email, password) { setUser(await api.login(email, password)); },
    async signUp(displayName, email, password) { setUser(await api.register(displayName, email, password)); },
    async signOut() { await api.logout(); setUser(null); },
  }), [user, loading]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth must be used inside AuthProvider');
  return context;
}

export function RequireAuth({ children }: { children: ReactNode }) {
  const { user, loading } = useAuth();
  if (loading) return <div className="screen-center"><div className="spinner" /></div>;
  if (!user) return <NavigateToLogin />;
  return <>{children}</>;
}

function NavigateToLogin() {
  window.history.replaceState({}, '', '/login');
  window.dispatchEvent(new PopStateEvent('popstate'));
  return null;
}
