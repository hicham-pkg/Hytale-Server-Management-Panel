'use client';

import { type ReactNode, useEffect } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { useAuth } from '@/hooks/use-auth';
import { isAdminOnlyPath, isProtectedPath } from '@/lib/auth-session';

export function AuthGate({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const { user, loading } = useAuth();
  const protectedPath = isProtectedPath(pathname);
  const adminOnlyPath = isAdminOnlyPath(pathname);

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

  if (protectedPath && user && adminOnlyPath && user.role !== 'admin') {
    return (
      <div className="flex h-screen items-center justify-center px-6">
        <div className="max-w-md space-y-3 rounded-lg border bg-card p-6 text-center">
          <h1 className="text-lg font-semibold">Admin Access Required</h1>
          <p className="text-sm text-muted-foreground">
            This page is restricted to admin accounts.
          </p>
          <button
            className="inline-flex items-center rounded-md border px-3 py-2 text-sm hover:bg-accent"
            onClick={() => router.replace('/dashboard')}
          >
            Back to Dashboard
          </button>
        </div>
      </div>
    );
  }

  return <>{children}</>;
}
