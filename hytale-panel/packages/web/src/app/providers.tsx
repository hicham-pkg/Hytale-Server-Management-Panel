'use client';

import { type ReactNode } from 'react';
import { AuthGate } from '@/components/auth/auth-gate';
import { AuthContext, useAuthProvider } from '@/hooks/use-auth';

export function Providers({ children }: { children: ReactNode }) {
  const auth = useAuthProvider();
  return (
    <AuthContext.Provider value={auth}>
      <AuthGate>{children}</AuthGate>
    </AuthContext.Provider>
  );
}
