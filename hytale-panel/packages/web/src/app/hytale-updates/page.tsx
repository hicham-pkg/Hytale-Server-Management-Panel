'use client';

import { useEffect, useRef, useState } from 'react';
import { AppShell } from '@/components/layout/app-shell';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/shared/confirm-dialog';
import { apiGet, apiPost } from '@/lib/api-client';
import { AlertTriangle, Download, RefreshCw, ShieldCheck, XCircle } from 'lucide-react';
import {
  DEFAULT_ADVANCED_EXPANDED,
  DEFAULT_LOGS_EXPANDED,
  APPLY_CONFIRM_DESCRIPTION,
  getHytaleUpdateUiModel,
  type HytaleUpdateAction,
  type HytaleUpdateJob,
  type HytaleUpdateOverview,
  type PrimaryUpdateAction,
  type UpdateStatus,
} from '@/lib/hytale-update-ui';

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
  const [advancedOpen, setAdvancedOpen] = useState(DEFAULT_ADVANCED_EXPANDED);
  const [logsExpanded, setLogsExpanded] = useState(DEFAULT_LOGS_EXPANDED);
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
          setLogsExpanded(latest?.status === 'failed');
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

  const model = getHytaleUpdateUiModel(overview, job);

  useEffect(() => {
    if (model.autoExpandLogs) setLogsExpanded(true);
  }, [model.autoExpandLogs]);

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

  const currentStatus = model.currentStatus;
  const running = job?.status === 'running';

  const renderActionButton = (action: PrimaryUpdateAction, variant: 'default' | 'outline' | 'warning' | 'destructive' = 'default') => {
    const actionName = action.action;
    const disabled = running || loadingAction !== null || actionName === null;
    const button = (
      <Button
        size="sm"
        variant={variant}
        disabled={disabled}
        onClick={action.confirmTitle || !actionName ? undefined : () => void startAction(actionName)}
      >
        {actionName === 'update-now' && <ShieldCheck className="mr-1 h-3 w-3" />}
        {actionName === 'check' && <RefreshCw className="mr-1 h-3 w-3" />}
        {action.label}
      </Button>
    );

    if (!action.confirmTitle || !actionName) return button;

    return (
      <ConfirmDialog
        title={action.confirmTitle}
        description={action.confirmDescription ?? ''}
        confirmLabel={action.confirmLabel ?? 'Confirm'}
        onConfirm={() => startAction(actionName)}
      >
        {button}
      </ConfirmDialog>
    );
  };

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
              {model.statusLabel}
            </span>
          </CardHeader>
          <CardContent className="space-y-4 text-sm">
            {!overview?.enabled && (
              <div className="rounded-md border border-yellow-800 bg-yellow-900/20 px-3 py-2 text-yellow-300">
                Hytale Server Update Manager is disabled by configuration.
              </div>
            )}

            <div className="grid gap-3 md:grid-cols-4">
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
            </div>

            {model.showUpdateWarning && (
              <div className="rounded-md border border-yellow-800 bg-yellow-900/20 px-3 py-2 text-xs text-yellow-200">
                <div className="flex gap-2">
                  <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                  <div className="space-y-1">
                    <p>A Hytale update is ready. Review the confirmation before applying it.</p>
                    <p>The server will restart and mods may need updates after the update.</p>
                  </div>
                </div>
              </div>
            )}

            <div className="flex flex-wrap gap-2">
              {renderActionButton(model.primaryAction, model.primaryAction.action === 'check' ? 'outline' : 'warning')}
            </div>

            <div className="rounded-md border border-slate-800 bg-slate-950/30">
              <button
                type="button"
                className="flex w-full items-center justify-between px-3 py-2 text-left text-sm text-slate-200"
                onClick={() => setAdvancedOpen((open) => !open)}
              >
                <span>Advanced actions</span>
                <span className="text-xs text-muted-foreground">{advancedOpen ? 'Hide' : 'Show'}</span>
              </button>
              {advancedOpen && (
                <div className="space-y-3 border-t border-slate-800 px-3 py-3 text-xs text-slate-300">
                  <p className="text-muted-foreground">Use these only when you want to split Hytale&apos;s built-in update flow into separate steps.</p>
                  <div className="flex flex-wrap gap-2">
                    {model.showAdvancedDownload && (
                      <Button size="sm" variant="outline" disabled={running || loadingAction !== null} onClick={() => void startAction('download')}>
                        <Download className="mr-1 h-3 w-3" /> Download only
                      </Button>
                    )}
                    {model.showAdvancedApply && (
                      <ConfirmDialog
                        title="Apply staged Hytale update"
                        description={APPLY_CONFIRM_DESCRIPTION}
                        confirmLabel="Back up and apply"
                        onConfirm={() => startAction('apply')}
                      >
                        <Button size="sm" variant="warning" disabled={running || loadingAction !== null}>
                          Apply only
                        </Button>
                      </ConfirmDialog>
                    )}
                    {model.showAdvancedCancel && (
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
                    )}
                  </div>
                  <div className="rounded border border-slate-800 bg-black/20 p-3">
                    <p className="mb-2 font-medium text-slate-100">Raw update status</p>
                    <div className="grid gap-2 md:grid-cols-2">
                      <p>Update status: <span className="font-mono">{currentStatus}</span></p>
                      <p>Latest action: <span className="font-mono">{job?.action ?? 'none'}</span></p>
                      <p>Job state: <span className="font-mono">{job ? `${job.status} (${job.step}/${job.totalSteps} ${job.stepName})` : 'none'}</span></p>
                      <p>Job ID: <span className="font-mono">{job?.jobId ?? 'none'}</span></p>
                    </div>
                  </div>
                </div>
              )}
            </div>

            {feedback && (
              <p className={feedback.type === 'success' ? 'text-emerald-300' : 'text-red-300'}>{feedback.message}</p>
            )}
            {job?.error && <p className="text-red-300">{job.error}</p>}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between">
            <CardTitle className="text-base font-medium">Latest Job Logs</CardTitle>
            <Button size="sm" variant="outline" onClick={() => setLogsExpanded((expanded) => !expanded)}>
              {logsExpanded ? 'Hide technical logs' : 'Show technical logs'}
            </Button>
          </CardHeader>
          {logsExpanded && (
            <CardContent>
              {logsUnavailable ? (
              <p className="text-sm text-yellow-300">Logs unavailable for the latest Hytale update job.</p>
            ) : logs ? (
              <pre className="max-h-96 overflow-auto rounded-md border bg-slate-950 p-3 text-xs text-slate-200">{logs}</pre>
            ) : (
              <p className="text-sm text-muted-foreground">No Hytale update logs yet.</p>
            )}
            </CardContent>
          )}
        </Card>
      </div>
    </AppShell>
  );
}
