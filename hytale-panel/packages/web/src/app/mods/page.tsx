'use client';

import { useEffect, useState, type ChangeEvent } from 'react';
import { AppShell } from '@/components/layout/app-shell';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/shared/confirm-dialog';
import { useAuth } from '@/hooks/use-auth';
import { apiDelete, apiGet, apiPost, apiUploadMod } from '@/lib/api-client';
import { formatBytes, formatDate } from '@/lib/utils';
import { Package, Power, RotateCcw, ShieldCheck, Trash2, Upload } from 'lucide-react';

type ModStatus = 'active' | 'disabled';

interface ModInfo {
  name: string;
  sizeBytes: number;
  sha256: string;
  modifiedAt: string;
  status: ModStatus;
}

interface ModListResponse {
  active: ModInfo[];
  disabled: ModInfo[];
}

interface StagedModInfo {
  stagedId: string;
  originalName: string;
  sanitizedName: string;
  sizeBytes: number;
  sha256: string;
  extension: 'jar' | 'zip';
  stagedAt: string;
}

interface ModInstallResponse {
  mod: ModInfo;
  backupName: string;
}

interface ModActionResponse {
  message?: string;
  backupName?: string;
  removedFrom?: ModStatus;
}

interface ModRestartVerifyResponse {
  restartSucceeded: boolean;
  startupOk: boolean;
  errors: string[];
  rollbackPerformed: boolean;
  rollbackBackupName?: string;
  rollbackRestartSucceeded?: boolean;
  message: string;
}

interface InstallRouteResponse {
  install: ModInstallResponse;
  restart?: ModRestartVerifyResponse;
}

const ALLOWED_EXTENSIONS = ['.jar', '.zip'];

function isAllowedClientFile(file: File): boolean {
  const lower = file.name.toLowerCase();
  return ALLOWED_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

function shortHash(hash: string): string {
  return `${hash.slice(0, 12)}...`;
}

function encodeModName(name: string): string {
  return encodeURIComponent(name);
}

export default function ModsPage() {
  const { user } = useAuth();
  const [activeMods, setActiveMods] = useState<ModInfo[]>([]);
  const [disabledMods, setDisabledMods] = useState<ModInfo[]>([]);
  const [staged, setStaged] = useState<StagedModInfo | null>(null);
  const [restartResult, setRestartResult] = useState<ModRestartVerifyResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState(false);
  const [helperDegraded, setHelperDegraded] = useState(false);
  const [replaceAvailable, setReplaceAvailable] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');

  const isAdmin = user?.role === 'admin';

  const fetchMods = async () => {
    const res = await apiGet<ModListResponse>('/api/mods');
    if (res.success && res.data) {
      setActiveMods(res.data.active);
      setDisabledMods(res.data.disabled);
      setHelperDegraded(false);
      setError('');
    } else {
      setActiveMods([]);
      setDisabledMods([]);
      setHelperDegraded(res.degraded === true || res.statusCode === 502 || res.statusCode === 503);
      setError(res.error || 'Failed to fetch mods');
    }
    setLoading(false);
  };

  useEffect(() => {
    void fetchMods();
  }, []);

  const clearAlerts = () => {
    setError('');
    setMessage('');
  };

  const handleUpload = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) {
      return;
    }

    clearAlerts();
    setRestartResult(null);
    setReplaceAvailable(false);

    if (!isAllowedClientFile(file)) {
      setError('Only .jar and .zip mod uploads are allowed');
      return;
    }

    setActionLoading(true);
    const res = await apiUploadMod<{ staged: StagedModInfo }>('/api/mods/upload', file);
    if (res.success && res.data?.staged) {
      setStaged(res.data.staged);
      setMessage(`Staged ${res.data.staged.sanitizedName}`);
    } else {
      setError(res.error || 'Failed to upload mod');
    }
    setActionLoading(false);
  };

  const handleInstall = async (restartNow = false, replace = false) => {
    if (!staged) {
      return;
    }

    clearAlerts();
    setRestartResult(null);
    setActionLoading(true);

    const res = await apiPost<InstallRouteResponse>('/api/mods/install', {
      stagedId: staged.stagedId,
      sanitizedName: staged.sanitizedName,
      sha256: staged.sha256,
      replace,
      restartNow,
      autoRollback: restartNow,
    });

    if (res.data?.restart) {
      setRestartResult(res.data.restart);
    }

    if (res.data?.install) {
      setStaged(null);
      setReplaceAvailable(false);
      await fetchMods();
      if (res.success) {
        setMessage(
          restartNow
            ? res.data.restart?.message || 'Mod installed and server restart verified'
            : 'Mod installed. Restart the server when you are ready to apply it.'
        );
      } else {
        setError(res.error || res.data.restart?.message || 'Mod installed, but restart verification failed');
      }
    } else {
      const nextError = res.error || 'Failed to install mod';
      setError(nextError);
      setReplaceAvailable(nextError.toLowerCase().includes('already exists'));
    }

    setActionLoading(false);
  };

  const runAction = async (action: () => Promise<{ success: boolean; data?: ModActionResponse | ModRestartVerifyResponse; error?: string; degraded?: boolean; statusCode?: number }>, successMessage: string) => {
    clearAlerts();
    setRestartResult(null);
    setActionLoading(true);
    const res = await action();
    if (res.success) {
      if ('startupOk' in (res.data ?? {})) {
        setRestartResult(res.data as ModRestartVerifyResponse);
      }
      setMessage((res.data as ModActionResponse | undefined)?.message || successMessage);
      await fetchMods();
    } else {
      setError(res.error || successMessage);
      setHelperDegraded(res.degraded === true || res.statusCode === 502 || res.statusCode === 503);
      if (res.data && 'startupOk' in res.data) {
        setRestartResult(res.data as ModRestartVerifyResponse);
      }
    }
    setActionLoading(false);
  };

  const handleDisable = (name: string) => runAction(
    () => apiPost<ModActionResponse>(`/api/mods/${encodeModName(name)}/disable`),
    'Mod disabled'
  );

  const handleEnable = (name: string) => runAction(
    () => apiPost<ModActionResponse>(`/api/mods/${encodeModName(name)}/enable`),
    'Mod enabled'
  );

  const handleDelete = (name: string) => runAction(
    () => apiDelete<ModActionResponse>(`/api/mods/${encodeModName(name)}?confirm=${encodeURIComponent(name)}`),
    'Mod removed'
  );

  const handleBackup = () => runAction(
    () => apiPost<ModActionResponse>('/api/mods/backup'),
    'Mods backup created'
  );

  const handleRollback = () => runAction(
    () => apiPost<ModActionResponse>('/api/mods/rollback'),
    'Mods backup restored'
  );

  const handleRestart = () => runAction(
    () => apiPost<ModRestartVerifyResponse>('/api/mods/restart-apply', { autoRollback: false }),
    'Server restart completed'
  );

  const renderModsTable = (mods: ModInfo[], status: ModStatus) => (
    <div className="overflow-x-auto rounded-md border">
      <table className="w-full text-sm">
        <thead className="bg-secondary/40 text-left text-xs uppercase text-muted-foreground">
          <tr>
            <th className="px-3 py-2">Name</th>
            <th className="px-3 py-2">Size</th>
            <th className="px-3 py-2">SHA256</th>
            <th className="px-3 py-2">Modified</th>
            <th className="px-3 py-2">Status</th>
            {isAdmin && <th className="px-3 py-2 text-right">Actions</th>}
          </tr>
        </thead>
        <tbody>
          {mods.map((mod) => (
            <tr key={`${status}-${mod.name}`} className="border-t">
              <td className="px-3 py-2 font-mono">{mod.name}</td>
              <td className="px-3 py-2 text-muted-foreground">{formatBytes(mod.sizeBytes)}</td>
              <td className="px-3 py-2 font-mono text-xs text-muted-foreground">{shortHash(mod.sha256)}</td>
              <td className="px-3 py-2 text-muted-foreground">{formatDate(mod.modifiedAt)}</td>
              <td className="px-3 py-2">
                <span className={status === 'active' ? 'text-emerald-400' : 'text-yellow-300'}>
                  {status}
                </span>
              </td>
              {isAdmin && (
                <td className="px-3 py-2">
                  <div className="flex justify-end gap-2">
                    {status === 'active' ? (
                      <Button variant="outline" size="sm" disabled={actionLoading} onClick={() => handleDisable(mod.name)}>
                        Disable
                      </Button>
                    ) : (
                      <Button variant="success" size="sm" disabled={actionLoading} onClick={() => handleEnable(mod.name)}>
                        Enable
                      </Button>
                    )}
                    <ConfirmDialog
                      title="Delete Mod"
                      description={`Move ${mod.name} out of the managed mods list after creating a backup?`}
                      confirmLabel="Delete"
                      variant="destructive"
                      onConfirm={() => handleDelete(mod.name)}
                    >
                      <Button variant="ghost" size="sm" disabled={actionLoading} className="text-red-400">
                        <Trash2 className="h-3 w-3" />
                      </Button>
                    </ConfirmDialog>
                  </div>
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );

  return (
    <AppShell>
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-bold">Mods Manager</h1>
          <p className="text-muted-foreground">Upload, enable, disable, and safely apply Hytale server mods</p>
        </div>

        {error && <div className="rounded-md bg-red-900/20 border border-red-800 p-3 text-sm text-red-400">{error}</div>}
        {message && <div className="rounded-md bg-emerald-900/20 border border-emerald-800 p-3 text-sm text-emerald-400">{message}</div>}
        {helperDegraded && (
          <div className="rounded-md border border-yellow-800 bg-yellow-900/20 p-3 text-sm text-yellow-300">
            Helper dependency is degraded. Mod actions are unavailable until helper connectivity is restored.
          </div>
        )}

        {isAdmin && (
          <div className="grid gap-6 lg:grid-cols-[1.3fr_1fr]">
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-base">
                  <Upload className="h-4 w-4" />
                  Upload Mod
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <label className="flex cursor-pointer flex-col items-center justify-center rounded-lg border border-dashed p-8 text-center hover:bg-accent/40">
                  <Upload className="mb-3 h-8 w-8 text-muted-foreground" />
                  <span className="font-medium">Choose one .jar or .zip file</span>
                  <span className="mt-1 text-xs text-muted-foreground">Files are staged first and are never extracted or executed.</span>
                  <input
                    className="sr-only"
                    type="file"
                    accept=".jar,.zip,application/java-archive,application/zip"
                    disabled={actionLoading || helperDegraded}
                    onChange={handleUpload}
                  />
                </label>
                {actionLoading && (
                  <div className="h-2 overflow-hidden rounded bg-secondary">
                    <div className="h-full w-1/2 animate-pulse rounded bg-primary" />
                  </div>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-base">
                  <ShieldCheck className="h-4 w-4" />
                  Pending Install
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                {staged ? (
                  <>
                    <div className="space-y-2 rounded-md border p-3 text-sm">
                      <div className="flex justify-between gap-4"><span className="text-muted-foreground">Name</span><span className="font-mono">{staged.sanitizedName}</span></div>
                      <div className="flex justify-between gap-4"><span className="text-muted-foreground">Size</span><span>{formatBytes(staged.sizeBytes)}</span></div>
                      <div className="flex justify-between gap-4"><span className="text-muted-foreground">SHA256</span><span className="font-mono text-xs">{shortHash(staged.sha256)}</span></div>
                      <div className="flex justify-between gap-4"><span className="text-muted-foreground">Staged</span><span>{formatDate(staged.stagedAt)}</span></div>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      <Button disabled={actionLoading || helperDegraded} onClick={() => handleInstall(false, false)}>
                        Install
                      </Button>
                      <ConfirmDialog
                        title="Install and Restart"
                        description="This installs the staged mod, restarts the Hytale service, scans recent logs for common mod startup errors, and rolls back automatically if verification fails."
                        confirmLabel="Install + Restart"
                        variant="destructive"
                        onConfirm={() => handleInstall(true, false)}
                      >
                        <Button variant="warning" disabled={actionLoading || helperDegraded}>
                          Install + Restart
                        </Button>
                      </ConfirmDialog>
                      {replaceAvailable && (
                        <ConfirmDialog
                          title="Replace Existing Mod"
                          description={`Replace the existing ${staged.sanitizedName}? A backup is created first.`}
                          confirmLabel="Replace"
                          variant="destructive"
                          onConfirm={() => handleInstall(false, true)}
                        >
                          <Button variant="destructive" disabled={actionLoading || helperDegraded}>
                            Replace Existing
                          </Button>
                        </ConfirmDialog>
                      )}
                    </div>
                  </>
                ) : (
                  <p className="text-sm text-muted-foreground">Upload a mod to review its staged filename, size, and SHA256 before installing.</p>
                )}
              </CardContent>
            </Card>
          </div>
        )}

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Package className="h-4 w-4" />
              Installed Mods
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-6">
            {loading ? (
              <p className="text-sm text-muted-foreground">Loading...</p>
            ) : activeMods.length === 0 && disabledMods.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                {helperDegraded ? 'No helper-backed mod listing available while helper is degraded.' : 'No mods installed.'}
              </p>
            ) : (
              <>
                <div className="space-y-2">
                  <h2 className="text-sm font-semibold">Active ({activeMods.length})</h2>
                  {activeMods.length > 0 ? renderModsTable(activeMods, 'active') : <p className="text-sm text-muted-foreground">No active mods.</p>}
                </div>
                <div className="space-y-2">
                  <h2 className="text-sm font-semibold">Disabled ({disabledMods.length})</h2>
                  {disabledMods.length > 0 ? renderModsTable(disabledMods, 'disabled') : <p className="text-sm text-muted-foreground">No disabled mods.</p>}
                </div>
              </>
            )}
          </CardContent>
        </Card>

        {isAdmin && (
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Safety Actions</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="flex flex-wrap gap-2">
                <Button variant="outline" disabled={actionLoading || helperDegraded} onClick={handleBackup}>
                  Backup Mods Now
                </Button>
                <ConfirmDialog
                  title="Rollback Mods"
                  description="Restore the latest mods backup. A pre-rollback backup is created first. Restart the server afterward to apply the restored set."
                  confirmLabel="Rollback"
                  variant="destructive"
                  onConfirm={handleRollback}
                >
                  <Button variant="destructive" disabled={actionLoading || helperDegraded}>
                    <RotateCcw className="mr-1 h-4 w-4" />
                    Rollback Last Backup
                  </Button>
                </ConfirmDialog>
                <ConfirmDialog
                  title="Restart Server"
                  description="Restart hytale-tmux.service and scan recent logs for common mod startup errors. This may disconnect online players."
                  confirmLabel="Restart"
                  variant="destructive"
                  onConfirm={handleRestart}
                >
                  <Button variant="warning" disabled={actionLoading || helperDegraded}>
                    <Power className="mr-1 h-4 w-4" />
                    Restart Server
                  </Button>
                </ConfirmDialog>
              </div>
            </CardContent>
          </Card>
        )}

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Recent Mod Logs</CardTitle>
          </CardHeader>
          <CardContent>
            {restartResult ? (
              <div className="space-y-3 text-sm">
                <p className={restartResult.startupOk ? 'text-emerald-400' : 'text-red-400'}>{restartResult.message}</p>
                <div className="flex flex-wrap gap-2 text-xs text-muted-foreground">
                  <span>Restart: {restartResult.restartSucceeded ? 'succeeded' : 'failed'}</span>
                  <span>Startup check: {restartResult.startupOk ? 'passed' : 'failed'}</span>
                  <span>Rollback: {restartResult.rollbackPerformed ? 'performed' : 'not performed'}</span>
                </div>
                {restartResult.errors.length > 0 && (
                  <pre className="max-h-64 overflow-auto rounded-md bg-black/30 p-3 text-xs text-red-200">
                    {restartResult.errors.join('\n')}
                  </pre>
                )}
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">Restart verification results and detected mod startup errors will appear here.</p>
            )}
          </CardContent>
        </Card>
      </div>
    </AppShell>
  );
}
