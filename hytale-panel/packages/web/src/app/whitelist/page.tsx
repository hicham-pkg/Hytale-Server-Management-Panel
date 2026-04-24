'use client';

import { useEffect, useState, type FormEvent } from 'react';
import { AppShell } from '@/components/layout/app-shell';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useAuth } from '@/hooks/use-auth';
import { apiGet, apiPost } from '@/lib/api-client';
import { Plus, Trash2, Shield, ToggleLeft, ToggleRight, AlertTriangle, UserMinus } from 'lucide-react';

interface WhitelistData {
  enabled: boolean;
  list: string[];
  serverRunning: boolean;
}

export default function WhitelistPage() {
  const { user } = useAuth();
  const [whitelistEnabled, setWhitelistEnabled] = useState(false);
  const [uuidList, setUuidList] = useState<string[]>([]);
  const [serverRunning, setServerRunning] = useState<boolean | null>(null);
  const [newPlayer, setNewPlayer] = useState('');
  const [removePlayerName, setRemovePlayerName] = useState('');
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');

  const fetchWhitelist = async () => {
    const res = await apiGet<WhitelistData>('/api/whitelist');
    if (res.success && res.data) {
      setWhitelistEnabled(res.data.enabled);
      setUuidList(res.data.list);
      setServerRunning(res.data.serverRunning);
      setError('');
    } else {
      setWhitelistEnabled(false);
      setUuidList([]);
      setServerRunning(null);
      setError(res.error || 'Failed to fetch whitelist');
    }
    setLoading(false);
  };

  useEffect(() => {
    fetchWhitelist();
  }, []);

  const handleAdd = async (e: FormEvent) => {
    e.preventDefault();
    if (!newPlayer.trim()) return;
    setActionLoading(true);
    setError('');
    setMessage('');

    const res = await apiPost<{ message: string }>('/api/whitelist/add', { name: newPlayer.trim() });
    if (res.success) {
      setMessage(res.data?.message || 'Player added');
      setNewPlayer('');
      fetchWhitelist();
    } else {
      setError(res.error || 'Failed to add player');
    }
    setActionLoading(false);
  };

  /**
   * Online remove: by player name via console command.
   */
  const handleRemoveOnline = async (e: FormEvent) => {
    e.preventDefault();
    if (!removePlayerName.trim()) return;
    setActionLoading(true);
    setError('');
    setMessage('');

    const res = await apiPost<{ message: string }>('/api/whitelist/remove', { name: removePlayerName.trim() });
    if (res.success) {
      setMessage(res.data?.message || 'Player removed');
      setRemovePlayerName('');
      fetchWhitelist();
    } else {
      setError(res.error || 'Failed to remove player');
    }
    setActionLoading(false);
  };

  /**
   * Offline remove: by UUID from file directly.
   */
  const handleRemoveOffline = async (uuid: string) => {
    setActionLoading(true);
    setError('');
    setMessage('');

    const res = await apiPost<{ message: string }>('/api/whitelist/remove-offline', { uuid });
    if (res.success) {
      setMessage(res.data?.message || 'UUID removed from file');
      fetchWhitelist();
    } else {
      setError(res.error || 'Failed to remove UUID');
    }
    setActionLoading(false);
  };

  const handleToggle = async () => {
    setActionLoading(true);
    setError('');
    setMessage('');

    const res = await apiPost<{ message: string }>('/api/whitelist/toggle', { enabled: !whitelistEnabled });
    if (res.success) {
      setMessage(res.data?.message || `Whitelist ${!whitelistEnabled ? 'enabled' : 'disabled'}`);
      fetchWhitelist();
    } else {
      setError(res.error || 'Failed to toggle whitelist');
    }
    setActionLoading(false);
  };

  const isAdmin = user?.role === 'admin';

  return (
    <AppShell>
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-bold">Whitelist Management</h1>
          <p className="text-muted-foreground">Manage which players can join the server</p>
        </div>

        {error && <div className="rounded-md bg-red-900/20 border border-red-800 p-3 text-sm text-red-400">{error}</div>}
        {message && <div className="rounded-md bg-emerald-900/20 border border-emerald-800 p-3 text-sm text-emerald-400">{message}</div>}

        {/* Server status indicator */}
        <div className={`rounded-md p-3 text-sm ${
          serverRunning === null
            ? 'bg-yellow-900/20 border border-yellow-800 text-yellow-300'
            : serverRunning
              ? 'bg-emerald-900/20 border border-emerald-800 text-emerald-400'
              : 'bg-yellow-900/20 border border-yellow-800 text-yellow-400'
        }`}>
          Server is <strong>{serverRunning === null ? 'unavailable' : (serverRunning ? 'online' : 'offline')}</strong>
          {serverRunning === null
            ? ' — Helper status is degraded. Runtime whitelist actions are temporarily unavailable.'
            : serverRunning
              ? ' — Add/remove players by username via console commands.'
              : ' — You can toggle the whitelist and remove UUIDs from the file. Adding players requires the server to be running.'}
        </div>

        {/* Whitelist toggle */}
        {isAdmin && (
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center justify-between text-base">
                <span className="flex items-center gap-2">
                  <Shield className="h-4 w-4" />
                  Whitelist Status
                </span>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleToggle}
                  disabled={actionLoading || serverRunning === null}
                  title={serverRunning === null ? 'Helper status is degraded — toggle unavailable' : undefined}
                >
                  {whitelistEnabled ? (
                    <><ToggleRight className="mr-1 h-4 w-4 text-emerald-400" /> Enabled</>
                  ) : (
                    <><ToggleLeft className="mr-1 h-4 w-4 text-muted-foreground" /> Disabled</>
                  )}
                </Button>
              </CardTitle>
            </CardHeader>
          </Card>
        )}

        {/* Add player — only when server is running */}
        {isAdmin && (
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Add Player (Online)</CardTitle>
            </CardHeader>
            <CardContent>
              {serverRunning ? (
                <form onSubmit={handleAdd} className="flex gap-2">
                  <Input
                    value={newPlayer}
                    onChange={(e) => setNewPlayer(e.target.value)}
                    placeholder="Player name (server resolves to UUID)"
                    pattern="[a-zA-Z0-9_]{1,32}"
                    title="Alphanumeric and underscores, 1-32 characters"
                    required
                  />
                  <Button type="submit" disabled={actionLoading}>
                    <Plus className="mr-1 h-4 w-4" />
                    Add
                  </Button>
                </form>
              ) : serverRunning === false ? (
                <div className="flex items-start gap-3 rounded-md bg-yellow-900/20 border border-yellow-800 p-3">
                  <AlertTriangle className="h-5 w-5 text-yellow-400 mt-0.5 shrink-0" />
                  <div className="text-sm text-yellow-300">
                    <p className="font-medium">Server is offline</p>
                    <p className="text-yellow-400/80 mt-1">
                      Adding players by name requires the server to be running.
                      The whitelist file stores UUIDs, and name-to-UUID resolution is only
                      available when the Hytale server is online.
                    </p>
                  </div>
                </div>
              ) : (
                <div className="flex items-start gap-3 rounded-md bg-yellow-900/20 border border-yellow-800 p-3">
                  <AlertTriangle className="h-5 w-5 text-yellow-400 mt-0.5 shrink-0" />
                  <div className="text-sm text-yellow-300">
                    <p className="font-medium">Server state unavailable</p>
                    <p className="text-yellow-400/80 mt-1">
                      Helper connectivity is degraded, so online/offline whitelist actions are temporarily disabled.
                    </p>
                  </div>
                </div>
              )}
            </CardContent>
          </Card>
        )}

        {/* Remove player by name — only when server is running */}
        {isAdmin && serverRunning === true && (
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <UserMinus className="h-4 w-4" />
                Remove Player by Username (Online)
              </CardTitle>
            </CardHeader>
            <CardContent>
              <form onSubmit={handleRemoveOnline} className="flex gap-2">
                <Input
                  value={removePlayerName}
                  onChange={(e) => setRemovePlayerName(e.target.value)}
                  placeholder="Player name to remove"
                  pattern="[a-zA-Z0-9_]{1,32}"
                  title="Alphanumeric and underscores, 1-32 characters"
                  required
                />
                <Button type="submit" variant="destructive" disabled={actionLoading}>
                  <Trash2 className="mr-1 h-4 w-4" />
                  Remove
                </Button>
              </form>
              <p className="text-xs text-muted-foreground mt-2">
                Sends a &quot;whitelist remove&quot; console command. The server resolves the name internally.
              </p>
            </CardContent>
          </Card>
        )}

        {/* Whitelist entries (UUIDs from file) */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Shield className="h-4 w-4" />
              Whitelisted Players — UUIDs ({uuidList.length})
            </CardTitle>
          </CardHeader>
          <CardContent>
            {loading ? (
              <p className="text-sm text-muted-foreground">Loading...</p>
            ) : uuidList.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                {error ? 'Whitelist is unavailable right now.' : 'No players whitelisted'}
              </p>
            ) : (
              <div className="space-y-2">
                {uuidList.map((uuid) => (
                  <div
                    key={uuid}
                    className="flex items-center justify-between rounded-md border px-4 py-2"
                  >
                    <span className="font-mono text-sm">{uuid}</span>
                    {isAdmin && serverRunning === false && (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => handleRemoveOffline(uuid)}
                        disabled={actionLoading}
                        className="text-red-400 hover:text-red-300"
                        title="Remove this UUID from the whitelist file (offline only)"
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    )}
                  </div>
                ))}
              </div>
            )}
            {!loading && uuidList.length > 0 && (
              <p className="text-xs text-muted-foreground mt-3">
                The whitelist file stores player UUIDs. UUID-to-username resolution is not available.
                {serverRunning === true
                  ? ' To remove a player, use the "Remove by Username" form above.'
                  : serverRunning === false
                    ? ' While the server is offline, you can remove UUIDs directly from the file using the trash icon.'
                    : ' Server status is currently unavailable.'}
              </p>
            )}
          </CardContent>
        </Card>
      </div>
    </AppShell>
  );
}
