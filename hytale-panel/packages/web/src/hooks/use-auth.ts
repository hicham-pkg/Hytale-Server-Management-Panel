'use client';

import { createContext, useContext, useState, useCallback, useEffect, type ReactNode } from 'react';
import { performLogout } from '@/lib/auth-session';
import { apiGet, apiPost, setCsrfToken } from '@/lib/api-client';

interface User {
  id: string;
  username: string;
  role: string;
  totpEnabled?: boolean;
}

interface AuthContextType {
  user: User | null;
  loading: boolean;
  login: (
    username: string,
    password: string
  ) => Promise<{ success: boolean; requires2fa?: boolean; requiresTotpSetup?: boolean; error?: string }>;
  verifyTotp: (code: string) => Promise<{ success: boolean; error?: string }>;
  setupTotp: () => Promise<{ success: boolean; data?: { secret: string; qrDataUrl: string }; error?: string }>;
  confirmTotpSetup: (code: string) => Promise<{ success: boolean; error?: string }>;
  logout: () => Promise<void>;
  checkAuth: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType | null>(null);

export function useAuth(): AuthContextType {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}

export { AuthContext };

function getTotpSetupErrorMessage(error?: string): string {
  if (!error) {
    return 'Could not start TOTP setup';
  }

  if (error === 'Malformed JSON request body') {
    return 'TOTP setup request was malformed';
  }

  if (error === 'Internal server error') {
    return 'Could not start TOTP setup';
  }

  return error;
}

export function useAuthProvider(): AuthContextType {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  const checkAuth = useCallback(async () => {
    setLoading(true);
    try {
      const res = await apiGet<{ user: User; csrfToken: string }>('/api/auth/me');
      if (res.success && res.data) {
        setUser(res.data.user);
        if (res.data.csrfToken) setCsrfToken(res.data.csrfToken);
      } else {
        setUser(null);
        setCsrfToken('');
      }
    } catch {
      setUser(null);
      setCsrfToken('');
    } finally {
      setLoading(false);
    }
  }, []);

  const login = useCallback(async (username: string, password: string) => {
    const res = await apiPost<{ requires2fa?: boolean; requiresTotpSetup?: boolean; user?: User; csrfToken?: string }>(
      '/api/auth/login',
      { username, password }
    );

    if (!res.success) return { success: false, error: res.error };

    if (res.data?.requires2fa || res.data?.requiresTotpSetup) {
      if (res.data.csrfToken) setCsrfToken(res.data.csrfToken);
      return {
        success: true,
        requires2fa: res.data.requires2fa,
        requiresTotpSetup: res.data.requiresTotpSetup,
      };
    }

    if (res.data?.user) {
      setUser(res.data.user);
      if (res.data.csrfToken) setCsrfToken(res.data.csrfToken);
    }

    return { success: true };
  }, []);

  const verifyTotp = useCallback(async (code: string) => {
    const res = await apiPost<{ user?: User; csrfToken?: string }>(
      '/api/auth/verify-totp',
      { code }
    );

    if (!res.success) return { success: false, error: res.error };

    if (res.data?.user) {
      setUser(res.data.user);
      if (res.data.csrfToken) setCsrfToken(res.data.csrfToken);
    }

    return { success: true };
  }, []);

  const setupTotp = useCallback(async () => {
    const res = await apiPost<{ secret: string; qrDataUrl: string }>('/api/auth/setup-totp', {});
    if (!res.success) {
      return { success: false, error: getTotpSetupErrorMessage(res.error) };
    }

    return { success: true, data: res.data };
  }, []);

  const confirmTotpSetup = useCallback(async (code: string) => {
    const res = await apiPost<{ user?: User; csrfToken?: string }>('/api/auth/confirm-totp', { code });

    if (!res.success) {
      return { success: false, error: res.error };
    }

    if (res.data?.user) {
      setUser(res.data.user);
      if (res.data.csrfToken) setCsrfToken(res.data.csrfToken);
    }

    return { success: true };
  }, []);

  const logout = useCallback(async () => {
    await performLogout(
      () => apiPost('/api/auth/logout'),
      () => {
        setUser(null);
        setCsrfToken('');
        setLoading(false);
      }
    );
  }, []);

  useEffect(() => {
    checkAuth();
  }, [checkAuth]);

  return { user, loading, login, verifyTotp, setupTotp, confirmTotpSetup, logout, checkAuth };
}
