'use client';

import { useEffect, useState, type FormEvent } from 'react';
import { AppShell } from '@/components/layout/app-shell';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useAuth } from '@/hooks/use-auth';
import { apiGet, apiPost } from '@/lib/api-client';
import { Plus, Trash2, Ban } from 'lucide-react';

interface BanEntry {
  name: string;
  reason?: string;
  bannedAt?: string;
}

export default function BansPage() {
  const { user } = useAuth();
  const [entries, setEntries] = useState<BanEntry[]>([]);
  const [newPlayer, setNewPlayer] = useState('');
  const [reason, setReason] = useState('');
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');

  const fetchBans = async () => {
    const res = await apiGet<{ entries: BanEntry[] }>('/api/bans');
    if (res.success && res.data) setEntries(res.data.entries);
    setLoading(false);
  };

  useEffect(() => {
    fetchBans();
  }, []);

  const handleAdd = async (e: FormEvent) => {
    e.preventDefault();
    if (!newPlayer.trim()) return;
    setActionLoading(true);
    setError('');
    setMessage('');

    const res = await apiPost<{ message: string }>('/api/bans/add', {
      name: newPlayer.trim(),
      reason: reason.trim(),
    });
    if (res.success) {
      setMessage(res.data?.message || 'Player banned');
      setNewPlayer('');
      setReason('');
      fetchBans();
    } else {
      setError(res.error || 'Failed to ban player');
    }
    setActionLoading(false);
  };

  const handleRemove = async (name: string) => {
    setActionLoading(true);
    setError('');
    setMessage('');

    const res = await apiPost<{ message: string }>('/api/bans/remove', { name });
    if (res.success) {
      setMessage(res.data?.message || 'Player unbanned');
      fetchBans();
    } else {
      setError(res.error || 'Failed to unban player');
    }
    setActionLoading(false);
  };

  const isAdmin = user?.role === 'admin';

  return (
    <AppShell>
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-bold">Ban Management</h1>
          <p className="text-muted-foreground">Manage banned players</p>
        </div>

        {error && <div className="rounded-md bg-red-900/20 border border-red-800 p-3 text-sm text-red-400">{error}</div>}
        {message && <div className="rounded-md bg-emerald-900/20 border border-emerald-800 p-3 text-sm text-emerald-400">{message}</div>}

        {isAdmin && (
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Ban Player</CardTitle>
            </CardHeader>
            <CardContent>
              <form onSubmit={handleAdd} className="space-y-3">
                <div className="flex gap-2">
                  <Input
                    value={newPlayer}
                    onChange={(e) => setNewPlayer(e.target.value)}
                    placeholder="Player name"
                    pattern="[a-zA-Z0-9_]{1,32}"
                    required
                  />
                  <Input
                    value={reason}
                    onChange={(e) => setReason(e.target.value)}
                    placeholder="Reason (optional)"
                    maxLength={200}
                  />
                  <Button type="submit" disabled={actionLoading} variant="destructive">
                    <Plus className="mr-1 h-4 w-4" />
                    Ban
                  </Button>
                </div>
              </form>
            </CardContent>
          </Card>
        )}

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Ban className="h-4 w-4" />
              Banned Players ({entries.length})
            </CardTitle>
          </CardHeader>
          <CardContent>
            {loading ? (
              <p className="text-sm text-muted-foreground">Loading...</p>
            ) : entries.length === 0 ? (
              <p className="text-sm text-muted-foreground">No banned players</p>
            ) : (
              <div className="space-y-2">
                {entries.map((entry) => (
                  <div key={entry.name} className="flex items-center justify-between rounded-md border px-4 py-2">
                    <div>
                      <span className="font-mono text-sm">{entry.name}</span>
                      {entry.reason && (
                        <span className="ml-3 text-xs text-muted-foreground">— {entry.reason}</span>
                      )}
                    </div>
                    {isAdmin && (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => handleRemove(entry.name)}
                        disabled={actionLoading}
                        className="text-emerald-400 hover:text-emerald-300"
                      >
                        Unban
                      </Button>
                    )}
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </AppShell>
  );
}