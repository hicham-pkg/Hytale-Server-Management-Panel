'use client';

import { type ReactNode, useEffect } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { useAuth } from '@/hooks/use-auth';
import { isProtectedPath } from '@/lib/auth-session';

export function AuthGate({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const { user, loading } = useAuth();
  const protectedPath = isProtectedPath(pathname);

  useEffect(() => {
    if (!loading && protectedPath && !user) {
      router.replace('/login');
      router.refresh();
    }
  }, [loading, protectedPath, router, user]);

  if (protectedPath && (loading || !user)) {
    return (
      <div className="flex h-screen items-center justify-center">
        <div className="animate-pulse text-muted-foreground">Loading...</div>
      </div>
    );
  }

  return <>{children}</>;
}
