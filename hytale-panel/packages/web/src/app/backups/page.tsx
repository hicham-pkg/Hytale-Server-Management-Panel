'use client';

import { useEffect, useState, type FormEvent } from 'react';
import { AppShell } from '@/components/layout/app-shell';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ConfirmDialog } from '@/components/shared/confirm-dialog';
import { useAuth } from '@/hooks/use-auth';
import { apiGet, apiPost, apiDelete } from '@/lib/api-client';
import { formatBytes, formatDate } from '@/lib/utils';
import { Archive, Plus, RotateCcw, Trash2 } from 'lucide-react';

interface BackupMeta {
  id: string;
  filename: string;
  label: string | null;
  sizeBytes: number;
  sha256: string;
  createdAt: string;
  helperOffline?: boolean;
}

interface BackupsResponse {
  backups: BackupMeta[];
  helperOffline?: boolean;
}

export default function BackupsPage() {
  const { user } = useAuth();
  const [backups, setBackups] = useState<BackupMeta[]>([]);
  const [helperOffline, setHelperOffline] = useState(false);
  const [label, setLabel] = useState('');
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');

  const fetchBackups = async () => {
    const res = await apiGet<BackupsResponse>('/api/backups');
    if (res.success && res.data) {
      setBackups(res.data.backups);
      setHelperOffline(res.data.helperOffline === true || res.data.backups.some((backup) => backup.helperOffline === true));
      setError('');
    } else {
      setBackups([]);
      setHelperOffline(res.degraded === true || res.statusCode === 502 || res.statusCode === 503);
      setError(res.error || 'Failed to fetch backups');
    }
    setLoading(false);
  };

  useEffect(() => {
    fetchBackups();
  }, []);

  const handleCreate = async (e: FormEvent) => {
    e.preventDefault();
    setActionLoading(true);
    setError('');
    setMessage('');

    const body = label.trim() ? { label: label.trim() } : {};
    const res = await apiPost<{ backup: BackupMeta }>('/api/backups/create', body);
    if (res.success) {
      setMessage('Backup created successfully');
      setLabel('');
      fetchBackups();
    } else {
      setError(res.error || 'Failed to create backup');
      if (res.degraded) {
        setHelperOffline(true);
      }
    }
    setActionLoading(false);
  };

  const handleRestore = async (id: string) => {
    setActionLoading(true);
    setError('');
    setMessage('');

    const res = await apiPost<{ message: string; safetyBackup?: string }>(`/api/backups/${id}/restore`);
    if (res.success) {
      setMessage(
        `Backup restored. ${res.data?.safetyBackup ? `Safety snapshot: ${res.data.safetyBackup}` : ''}`
      );
      fetchBackups();
    } else {
      setError(res.error || 'Failed to restore backup');
      if (res.degraded) {
        setHelperOffline(true);
      }
    }
    setActionLoading(false);
  };

  const handleDelete = async (id: string) => {
    setActionLoading(true);
    setError('');
    setMessage('');

    const res = await apiDelete(`/api/backups/${id}`);
    if (res.success) {
      setMessage('Backup deleted');
      fetchBackups();
    } else {
      setError(res.error || 'Failed to delete backup');
      if (res.degraded) {
        setHelperOffline(true);
      }
    }
    setActionLoading(false);
  };

  const isAdmin = user?.role === 'admin';

  return (
    <AppShell>
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-bold">Backup Management</h1>
          <p className="text-muted-foreground">Create, restore, and manage world backups</p>
        </div>

        {error && <div className="rounded-md bg-red-900/20 border border-red-800 p-3 text-sm text-red-400">{error}</div>}
        {message && <div className="rounded-md bg-emerald-900/20 border border-emerald-800 p-3 text-sm text-emerald-400">{message}</div>}
        {helperOffline && (
          <div className="rounded-md border border-yellow-800 bg-yellow-900/20 p-3 text-sm text-yellow-300">
            Helper dependency is degraded. Backup actions may be unavailable until helper connectivity is restored.
          </div>
        )}

        {isAdmin && (
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Create Backup</CardTitle>
            </CardHeader>
            <CardContent>
              <form onSubmit={handleCreate} className="flex gap-2">
                <Input
                  value={label}
                  onChange={(e) => setLabel(e.target.value)}
                  placeholder="Label (optional, e.g. before-update)"
                  pattern="[a-zA-Z0-9_\-]{0,50}"
                />
                <Button
                  type="submit"
                  disabled={actionLoading || helperOffline}
                  title={helperOffline ? 'Helper is degraded — backup creation is unavailable' : undefined}
                >
                  <Plus className="mr-1 h-4 w-4" />
                  {actionLoading ? 'Creating...' : 'Create'}
                </Button>
              </form>
            </CardContent>
          </Card>
        )}

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Archive className="h-4 w-4" />
              Backups ({backups.length})
            </CardTitle>
          </CardHeader>
          <CardContent>
            {loading ? (
              <p className="text-sm text-muted-foreground">Loading...</p>
            ) : backups.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                {helperOffline ? 'No helper-backed backup listing available while helper is degraded' : 'No backups found'}
              </p>
            ) : (
              <div className="space-y-3">
                {backups.map((backup) => (
                  <div key={backup.id} className="flex items-center justify-between rounded-md border p-4">
                    <div className="space-y-1">
                      <div className="flex items-center gap-2">
                        <span className="font-mono text-sm">{backup.filename}</span>
                        {backup.label && (
                          <span className="rounded bg-secondary px-2 py-0.5 text-xs">{backup.label}</span>
                        )}
                        {backup.helperOffline && (
                          <span className="rounded bg-yellow-900/40 border border-yellow-800 px-2 py-0.5 text-xs text-yellow-300">
                            Helper offline
                          </span>
                        )}
                      </div>
                      <div className="flex gap-4 text-xs text-muted-foreground">
                        <span>{formatBytes(backup.sizeBytes)}</span>
                        <span>{formatDate(backup.createdAt)}</span>
                        <span className="font-mono">SHA256: {backup.sha256.slice(0, 12)}...</span>
                      </div>
                    </div>
                    {isAdmin && (
                      <div className="flex gap-2">
                        <ConfirmDialog
                          title="Restore Backup"
                          description="This will stop the server (if running), create a safety snapshot, and restore this backup. This action cannot be undone."
                          confirmLabel="Restore"
                          variant="destructive"
                          onConfirm={() => handleRestore(backup.id)}
                        >
                          <Button
                            variant="outline"
                            size="sm"
                            disabled={actionLoading || backup.helperOffline}
                            title={backup.helperOffline ? 'Helper is offline — restore is unavailable' : undefined}
                          >
                            <RotateCcw className="mr-1 h-3 w-3" />
                            Restore
                          </Button>
                        </ConfirmDialog>
                        <ConfirmDialog
                          title="Delete Backup"
                          description={`Permanently delete ${backup.filename}? This cannot be undone.`}
                          confirmLabel="Delete"
                          variant="destructive"
                          onConfirm={() => handleDelete(backup.id)}
                        >
                          <Button
                            variant="ghost"
                            size="sm"
                            disabled={actionLoading || backup.helperOffline}
                            className="text-red-400"
                            title={backup.helperOffline ? 'Helper is offline — delete is unavailable' : undefined}
                          >
                            <Trash2 className="h-3 w-3" />
                          </Button>
                        </ConfirmDialog>
                      </div>
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
