'use client';

import { useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/hooks/use-auth';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '@/components/ui/card';

export default function LoginPage() {
  const router = useRouter();
  const { login, verifyTotp, setupTotp, confirmTotpSetup } = useAuth();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [totpCode, setTotpCode] = useState('');
  const [needs2fa, setNeeds2fa] = useState(false);
  const [needsTotpSetup, setNeedsTotpSetup] = useState(false);
  const [totpSetup, setTotpSetup] = useState<{ secret: string; qrDataUrl: string } | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleLogin = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);

    try {
      const result = await login(username, password);
      if (!result.success) {
        setError(result.error || 'Login failed');
        return;
      }
      if (result.requiresTotpSetup) {
        setNeedsTotpSetup(true);
        setNeeds2fa(false);
        setTotpCode('');
        return;
      }
      if (result.requires2fa) {
        setNeeds2fa(true);
        setNeedsTotpSetup(false);
        return;
      }
      router.replace('/dashboard');
    } catch {
      setError('An unexpected error occurred');
    } finally {
      setLoading(false);
    }
  };

  const handleTotp = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);

    try {
      const result = await verifyTotp(totpCode);
      if (!result.success) {
        setError(result.error || 'Invalid code');
        return;
      }
      router.replace('/dashboard');
    } catch {
      setError('An unexpected error occurred');
    } finally {
      setLoading(false);
    }
  };

  const handleBeginTotpSetup = async () => {
    setError('');
    setLoading(true);

    try {
      const result = await setupTotp();
      if (!result.success || !result.data) {
        setError(result.error || 'Failed to start TOTP setup');
        return;
      }

      setTotpSetup(result.data);
    } catch {
      setError('An unexpected error occurred');
    } finally {
      setLoading(false);
    }
  };

  const handleConfirmTotpSetup = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);

    try {
      const result = await confirmTotpSetup(totpCode);
      if (!result.success) {
        setError(result.error || 'Invalid code');
        return;
      }

      router.replace('/dashboard');
    } catch {
      setError('An unexpected error occurred');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-4">
      <Card className="w-full max-w-sm">
        <CardHeader className="text-center">
          <div className="mx-auto mb-4 h-12 w-12 rounded-xl bg-primary flex items-center justify-center">
            <span className="text-xl font-bold text-primary-foreground">H</span>
          </div>
          <CardTitle>Hytale Panel</CardTitle>
          <CardDescription>
            {needsTotpSetup
              ? 'Admin accounts must enroll TOTP before they can access the panel'
              : needs2fa
                ? 'Enter your 2FA code'
                : 'Sign in to manage your server'}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {!needs2fa && !needsTotpSetup ? (
            <form onSubmit={handleLogin} className="space-y-4">
              <div className="space-y-2">
                <label className="text-sm font-medium" htmlFor="username">
                  Username
                </label>
                <Input
                  id="username"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  placeholder="admin"
                  autoComplete="username"
                  required
                />
              </div>
              <div className="space-y-2">
                <label className="text-sm font-medium" htmlFor="password">
                  Password
                </label>
                <Input
                  id="password"
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="••••••••••••"
                  autoComplete="current-password"
                  required
                />
              </div>
              {error && <p className="text-sm text-red-400">{error}</p>}
              <Button type="submit" className="w-full" disabled={loading}>
                {loading ? 'Signing in...' : 'Sign In'}
              </Button>
            </form>
          ) : needsTotpSetup ? (
            <div className="space-y-4">
              {!totpSetup ? (
                <>
                  <p className="text-sm text-muted-foreground">
                    Your password was correct, but admin access stays locked until you register an authenticator app.
                  </p>
                  {error && <p className="text-sm text-red-400">{error}</p>}
                  <Button type="button" className="w-full" disabled={loading} onClick={handleBeginTotpSetup}>
                    {loading ? 'Preparing...' : 'Begin TOTP Setup'}
                  </Button>
                </>
              ) : (
                <form onSubmit={handleConfirmTotpSetup} className="space-y-4">
                  <p className="text-sm text-muted-foreground">
                    Scan this QR code with your authenticator app, then enter the 6-digit code to finish the first admin login.
                  </p>
                  <img src={totpSetup.qrDataUrl} alt="Admin TOTP QR code" className="mx-auto h-48 w-48" />
                  <p className="text-center text-xs text-muted-foreground font-mono">
                    Secret: {totpSetup.secret}
                  </p>
                  <div className="space-y-2">
                    <label className="text-sm font-medium" htmlFor="totp-setup">
                      Authentication Code
                    </label>
                    <Input
                      id="totp-setup"
                      value={totpCode}
                      onChange={(e) => setTotpCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                      placeholder="000000"
                      maxLength={6}
                      autoComplete="one-time-code"
                      className="text-center text-2xl tracking-widest"
                      required
                    />
                  </div>
                  {error && <p className="text-sm text-red-400">{error}</p>}
                  <Button type="submit" className="w-full" disabled={loading || totpCode.length !== 6}>
                    {loading ? 'Finishing setup...' : 'Enable TOTP and Continue'}
                  </Button>
                </form>
              )}
            </div>
          ) : (
            <form onSubmit={handleTotp} className="space-y-4">
              <div className="space-y-2">
                <label className="text-sm font-medium" htmlFor="totp">
                  Authentication Code
                </label>
                <Input
                  id="totp"
                  value={totpCode}
                  onChange={(e) => setTotpCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                  placeholder="000000"
                  maxLength={6}
                  autoComplete="one-time-code"
                  className="text-center text-2xl tracking-widest"
                  required
                />
              </div>
              {error && <p className="text-sm text-red-400">{error}</p>}
              <Button type="submit" className="w-full" disabled={loading || totpCode.length !== 6}>
                {loading ? 'Verifying...' : 'Verify'}
              </Button>
            </form>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
