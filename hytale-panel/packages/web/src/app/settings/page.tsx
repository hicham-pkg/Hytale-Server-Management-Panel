'use client';

import { useEffect, useState, type FormEvent } from 'react';
import { AppShell } from '@/components/layout/app-shell';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useAuth } from '@/hooks/use-auth';
import { apiGet, apiPut, apiPost } from '@/lib/api-client';
import { Settings, Users, Key } from 'lucide-react';

interface UserInfo {
  id: string;
  username: string;
  role: string;
  totpEnabled: boolean;
}

export default function SettingsPage() {
  const { user, checkAuth } = useAuth();
  const [users, setUsers] = useState<UserInfo[]>([]);
  const [newUsername, setNewUsername] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [newRole, setNewRole] = useState('readonly');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [totpSetup, setTotpSetup] = useState<{ secret: string; qrDataUrl: string } | null>(null);
  const [totpCode, setTotpCode] = useState('');

  useEffect(() => {
    fetchUsers();
  }, []);

  const fetchUsers = async () => {
    const res = await apiGet<{ users: UserInfo[] }>('/api/users');
    if (res.success && res.data) setUsers(res.data.users);
    setLoading(false);
  };

  const handleCreateUser = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    setMessage('');

    const res = await apiPost('/api/users', {
      username: newUsername.trim(),
      password: newPassword,
      role: newRole,
    });

    if (res.success) {
      setMessage('User created');
      setNewUsername('');
      setNewPassword('');
      fetchUsers();
    } else {
      setError(res.error || 'Failed to create user');
    }
  };

  const handleSetup2fa = async () => {
    setError('');
    const res = await apiPost<{ secret: string; qrDataUrl: string }>('/api/auth/setup-totp');
    if (res.success && res.data) {
      setTotpSetup(res.data);
    } else {
      setError(res.error || 'Failed to setup 2FA');
    }
  };

  const handleConfirm2fa = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    const res = await apiPost('/api/auth/confirm-totp', { code: totpCode });
    if (res.success) {
      await checkAuth();
      setMessage('2FA enabled successfully');
      setTotpSetup(null);
      setTotpCode('');
    } else {
      setError(res.error || 'Invalid code');
    }
  };

  return (
    <AppShell>
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-bold">Settings</h1>
          <p className="text-muted-foreground">Panel configuration and user management</p>
        </div>

        {error && <div className="rounded-md bg-red-900/20 border border-red-800 p-3 text-sm text-red-400">{error}</div>}
        {message && <div className="rounded-md bg-emerald-900/20 border border-emerald-800 p-3 text-sm text-emerald-400">{message}</div>}

        {/* 2FA Setup */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Key className="h-4 w-4" />
              Two-Factor Authentication
            </CardTitle>
          </CardHeader>
          <CardContent>
            {user?.totpEnabled ? (
              <p className="text-sm text-emerald-400">✓ 2FA is enabled for your account</p>
            ) : totpSetup ? (
              <div className="space-y-4">
                <p className="text-sm text-muted-foreground">
                  Scan this QR code with your authenticator app:
                </p>
                <img src={totpSetup.qrDataUrl} alt="TOTP QR Code" className="mx-auto h-48 w-48" />
                <p className="text-xs text-muted-foreground text-center font-mono">
                  Secret: {totpSetup.secret}
                </p>
                <form onSubmit={handleConfirm2fa} className="flex gap-2">
                  <Input
                    value={totpCode}
                    onChange={(e) => setTotpCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                    placeholder="Enter 6-digit code"
                    maxLength={6}
                    className="text-center"
                  />
                  <Button type="submit" disabled={totpCode.length !== 6}>
                    Verify
                  </Button>
                </form>
              </div>
            ) : (
              <Button onClick={handleSetup2fa} variant="outline">
                Setup 2FA
              </Button>
            )}
          </CardContent>
        </Card>

        {/* User Management */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Users className="h-4 w-4" />
              User Management
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {loading ? (
              <p className="text-sm text-muted-foreground">Loading...</p>
            ) : (
              <div className="space-y-2">
                {users.map((u) => (
                  <div key={u.id} className="flex items-center justify-between rounded-md border px-4 py-2">
                    <div className="flex items-center gap-3">
                      <span className="font-medium">{u.username}</span>
                      <span className="rounded bg-secondary px-2 py-0.5 text-xs capitalize">{u.role}</span>
                      {u.totpEnabled && <span className="text-xs text-emerald-400">2FA</span>}
                    </div>
                    {u.id === user?.id && <span className="text-xs text-muted-foreground">(you)</span>}
                  </div>
                ))}
              </div>
            )}

            <div className="border-t pt-4">
              <h3 className="text-sm font-medium mb-3">Create New User</h3>
              <form onSubmit={handleCreateUser} className="space-y-3">
                <div className="flex gap-2">
                  <Input
                    value={newUsername}
                    onChange={(e) => setNewUsername(e.target.value)}
                    placeholder="Username"
                    pattern="[a-zA-Z0-9_]{3,50}"
                    required
                  />
                  <Input
                    type="password"
                    value={newPassword}
                    onChange={(e) => setNewPassword(e.target.value)}
                    placeholder="Password (min 12 chars)"
                    minLength={12}
                    required
                  />
                  <select
                    value={newRole}
                    onChange={(e) => setNewRole(e.target.value)}
                    className="rounded-md border bg-background px-3 py-2 text-sm"
                  >
                    <option value="readonly">Read Only</option>
                    <option value="admin">Admin</option>
                  </select>
                  <Button type="submit">Create</Button>
                </div>
              </form>
            </div>
          </CardContent>
        </Card>
      </div>
    </AppShell>
  );
}
