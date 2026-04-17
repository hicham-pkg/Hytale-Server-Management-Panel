import React, { createContext, useContext, useState, useEffect, useCallback } from 'react';
import { auth } from './api';

interface User {
  id: string;
  username: string;
  role: string;
  totpEnabled?: boolean;
}

interface AuthContextType {
  user: User | null;
  loading: boolean;
  isAdmin: boolean;
  login: (username: string, password: string) => Promise<{ requires2fa: boolean; error?: string }>;
  verifyTotp: (code: string) => Promise<{ error?: string }>;
  logout: () => Promise<void>;
  refresh: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const res = await auth.me();
      if (res.success && res.data?.user) {
        setUser(res.data.user);
      } else {
        setUser(null);
      }
    } catch {
      setUser(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const login = async (username: string, password: string) => {
    const res = await auth.login(username, password);
    if (!res.success) return { requires2fa: false, error: res.error || 'Login failed' };
    if (res.data?.requires2fa) return { requires2fa: true };
    if (res.data?.user) setUser(res.data.user);
    return { requires2fa: false };
  };

  const verifyTotp = async (code: string) => {
    const res = await auth.verifyTotp(code);
    if (!res.success) return { error: res.error || 'Invalid code' };
    if (res.data?.user) setUser(res.data.user);
    return {};
  };

  const logout = async () => {
    await auth.logout();
    setUser(null);
  };

  return (
    <AuthContext.Provider
      value={{
        user,
        loading,
        isAdmin: user?.role === 'admin',
        login,
        verifyTotp,
        logout,
        refresh,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}