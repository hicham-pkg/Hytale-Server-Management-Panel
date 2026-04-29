'use client';

import { useEffect, useRef, useState } from 'react';
import { AppShell } from '@/components/layout/app-shell';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/shared/confirm-dialog';
import { apiGet, apiPost } from '@/lib/api-client';
import { AlertTriangle, Download, RefreshCw, ShieldCheck, XCircle } from 'lucide-react';

type HytaleUpdateAction = 'check' | 'download' | 'apply' | 'update-now' | 'cancel';
type JobStatus = 'running' | 'success' | 'failed';
type UpdateStatus =
  | 'unknown'
  | 'checking'
  | 'up_to_date'
  | 'update_available'
  | 'downloading'
  | 'staged'
  | 'applying'
  | 'succeeded'
  | 'failed';

interface HytaleUpdateJob {
  jobId: string;
  kind: 'hytale-update';
  action: HytaleUpdateAction;
  step: number;
  stepName: string;
  totalSteps: number;
  status: JobStatus;
  updateStatus: UpdateStatus;
  startedAt: string;
  endedAt: string | null;
  error: string | null;
}

interface HytaleUpdateOverview {
  enabled: boolean;
  status: UpdateStatus;
  latestJob: HytaleUpdateJob | null;
  lastChecked: string | null;
  currentVersion: string | null;
  latestVersion: string | null;
  patchline: string | null;
}

const statusLabels: Record<UpdateStatus, string> = {
  unknown: 'Unknown',
  checking: 'Checking',
  up_to_date: 'Up to date',
  update_available: 'Update available',
  downloading: 'Downloading',
  staged: 'Staged',
  applying: 'Applying',
  succeeded: 'Succeeded',
  failed: 'Failed',
};

function statusClass(status: UpdateStatus) {
  if (status === 'failed') return 'bg-red-100 text-red-800';
  if (status === 'succeeded' || status === 'up_to_date') return 'bg-emerald-100 text-emerald-800';
  if (status === 'update_available' || status === 'staged') return 'bg-yellow-100 text-yellow-900';
  if (status === 'downloading' || status === 'applying' || status === 'checking') return 'bg-blue-100 text-blue-800';
  return 'bg-slate-800 text-slate-200';
}

export default function HytaleUpdatesPage() {
  const [overview, setOverview] = useState<HytaleUpdateOverview | null>(null);
  const [job, setJob] = useState<HytaleUpdateJob | null>(null);
  const [logs, setLogs] = useState('');
  const [logsUnavailable, setLogsUnavailable] = useState(false);
  const [loadingAction, setLoadingAction] = useState<HytaleUpdateAction | null>(null);
  const [feedback, setFeedback] = useState<{ type: 'success' | 'error'; message: string } | null>(null);
  const jobIdRef = useRef<string | null>(null);

  const loadOverview = async () => {
    const res = await apiGet<HytaleUpdateOverview>('/api/hytale-updates/status');
    if (res.success && res.data) {
      setOverview(res.data);
      setJob(res.data.latestJob);
    } else {
      setFeedback({ type: 'error', message: res.error ?? 'Could not load Hytale update status' });
    }
  };

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const loop = async () => {
      const res = await apiGet<HytaleUpdateJob | null>('/api/hytale-updates/jobs/latest');
      if (cancelled) return;
      if (res.success) {
        const latest = res.data ?? null;
        const nextId = latest?.jobId ?? null;
        if (jobIdRef.current !== nextId) {
          jobIdRef.current = nextId;
          setLogs('');
          setLogsUnavailable(false);
        }
        setJob(latest);
        if (latest) {
          const logRes = await apiGet<{ content: string; nextCursor: number; totalBytes: number }>(
            `/api/hytale-updates/jobs/${latest.jobId}/logs`,
          );
          if (!cancelled && logRes.success && logRes.data) {
            setLogs(logRes.data.content);
            setLogsUnavailable(false);
          } else if (!cancelled) {
            setLogs('');
            setLogsUnavailable(true);
          }
        }
      }
      if (cancelled) return;
      timer = setTimeout(loop, res.data?.status === 'running' ? 2_000 : 10_000);
    };

    void loadOverview();
    void loop();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, []);

  const startAction = async (action: HytaleUpdateAction) => {
    setLoadingAction(action);
    setFeedback(null);
    const res = await apiPost<{ jobId: string }>(`/api/hytale-updates/${action}`, {});
    if (res.success && res.data) {
      setFeedback({ type: 'success', message: 'Hytale update job started. Watching progress…' });
      await loadOverview();
    } else {
      setFeedback({ type: 'error', message: res.error ?? 'Could not start Hytale update job' });
    }
    setLoadingAction(null);
  };

  const currentStatus = job?.updateStatus ?? overview?.status ?? 'unknown';
  const running = job?.status === 'running';

  return (
    <AppShell>
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-bold">Hytale Server Updates</h1>
          <p className="text-muted-foreground">Use Hytale&apos;s built-in update commands through the protected helper boundary.</p>
        </div>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="flex items-center gap-2 text-base font-medium">
              <RefreshCw className="h-4 w-4" /> Update Status
            </CardTitle>
            <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${statusClass(currentStatus)}`}>
              {statusLabels[currentStatus]}
            </span>
          </CardHeader>
          <CardContent className="space-y-4 text-sm">
            {!overview?.enabled && (
              <div className="rounded-md border border-yellow-800 bg-yellow-900/20 px-3 py-2 text-yellow-300">
                Hytale Server Update Manager is disabled by configuration.
              </div>
            )}

            <div className="grid gap-3 md:grid-cols-3">
              <div className="rounded-md border bg-slate-950/40 p-3">
                <p className="text-xs text-muted-foreground">Current Hytale version</p>
                <p className="font-mono text-xs">{overview?.currentVersion ?? 'unknown'}</p>
              </div>
              <div className="rounded-md border bg-slate-950/40 p-3">
                <p className="text-xs text-muted-foreground">Latest available</p>
                <p className="font-mono text-xs">{overview?.latestVersion ?? 'unknown'}</p>
              </div>
              <div className="rounded-md border bg-slate-950/40 p-3">
                <p className="text-xs text-muted-foreground">Patchline</p>
                <p className="font-mono text-xs">{overview?.patchline ?? 'unknown'}</p>
              </div>
              <div className="rounded-md border bg-slate-950/40 p-3">
                <p className="text-xs text-muted-foreground">Last checked/job</p>
                <p className="font-mono text-xs">{overview?.lastChecked ? new Date(overview.lastChecked).toLocaleString() : 'Never'}</p>
              </div>
              <div className="rounded-md border bg-slate-950/40 p-3">
                <p className="text-xs text-muted-foreground">Latest action</p>
                <p className="font-mono text-xs">{job?.action ?? 'none'}</p>
              </div>
              <div className="rounded-md border bg-slate-950/40 p-3">
                <p className="text-xs text-muted-foreground">Job state</p>
                <p className="font-mono text-xs">{job ? `${job.status} (${job.step}/${job.totalSteps} ${job.stepName})` : 'none'}</p>
              </div>
            </div>

            <div className="rounded-md border border-yellow-800 bg-yellow-900/20 px-3 py-2 text-xs text-yellow-200">
              <div className="flex gap-2">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                <div className="space-y-1">
                  <p>This restarts the Hytale server. Connected players may be disconnected.</p>
                  <p>A backup is created before applying.</p>
                  <p>Mods may need updates after a Hytale update.</p>
                  <p>No automatic rollback is performed in v1; use the pre-update backup for recovery if needed.</p>
                </div>
              </div>
            </div>

            <div className="flex flex-wrap gap-2">
              <Button size="sm" variant="outline" disabled={running || loadingAction !== null} onClick={() => void startAction('check')}>
                Check for updates
              </Button>
              <Button size="sm" variant="outline" disabled={running || loadingAction !== null} onClick={() => void startAction('download')}>
                <Download className="mr-1 h-3 w-3" /> Download update
              </Button>
              <ConfirmDialog
                title="Apply staged Hytale update"
                description="This creates a backup, warns players, applies the staged update, and waits for the server to restart. Connected players may be disconnected. Mods may need updates after this. Automatic rollback is not performed in v1."
                confirmLabel="Apply update"
                onConfirm={() => startAction('apply')}
              >
                <Button size="sm" variant="warning" disabled={running || loadingAction !== null}>
                  Apply staged update
                </Button>
              </ConfirmDialog>
              <ConfirmDialog
                title="Update Hytale now"
                description="This checks, downloads, backs up, applies, and restarts the Hytale server. Connected players may be disconnected. Mods may need updates after this. Automatic rollback is not performed in v1."
                confirmLabel="Update now"
                onConfirm={() => startAction('update-now')}
              >
                <Button size="sm" variant="warning" disabled={running || loadingAction !== null}>
                  <ShieldCheck className="mr-1 h-3 w-3" /> Update now
                </Button>
              </ConfirmDialog>
              <ConfirmDialog
                title="Cancel staged Hytale update"
                description="This sends Hytale's built-in /update cancel command. It does not restore files or roll back a completed apply."
                confirmLabel="Cancel staged update"
                variant="destructive"
                onConfirm={() => startAction('cancel')}
              >
                <Button size="sm" variant="destructive" disabled={running || loadingAction !== null}>
                  <XCircle className="mr-1 h-3 w-3" /> Cancel staged update
                </Button>
              </ConfirmDialog>
            </div>

            {feedback && (
              <p className={feedback.type === 'success' ? 'text-emerald-300' : 'text-red-300'}>{feedback.message}</p>
            )}
            {job?.error && <p className="text-red-300">{job.error}</p>}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base font-medium">Latest Job Logs</CardTitle>
          </CardHeader>
          <CardContent>
            {logsUnavailable ? (
              <p className="text-sm text-yellow-300">Logs unavailable for the latest Hytale update job.</p>
            ) : logs ? (
              <pre className="max-h-96 overflow-auto rounded-md border bg-slate-950 p-3 text-xs text-slate-200">{logs}</pre>
            ) : (
              <p className="text-sm text-muted-foreground">No Hytale update logs yet.</p>
            )}
          </CardContent>
        </Card>
      </div>
    </AppShell>
  );
}
