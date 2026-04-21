'use client';

import { useEffect, useState } from 'react';
import { AppShell } from '@/components/layout/app-shell';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { StatusBadge, SeverityBadge } from '@/components/shared/status-badge';
import { ConfirmDialog } from '@/components/shared/confirm-dialog';
import { useServerStatus } from '@/hooks/use-server-status';
import { useAuth } from '@/hooks/use-auth';
import { apiGet, apiPost } from '@/lib/api-client';
import { Play, Square, RotateCcw, Cpu, HardDrive, MemoryStick, AlertTriangle } from 'lucide-react';

interface SystemStats {
  cpuUsagePercent: number;
  memoryUsedMb: number;
  memoryTotalMb: number;
  memoryUsagePercent: number;
  diskUsedGb: number;
  diskTotalGb: number;
  diskUsagePercent: number;
}

interface CrashEvent {
  id: string;
  severity: string;
  summary: string;
  detectedAt: string;
}

export default function DashboardPage() {
  const { user } = useAuth();
  const { status, loading: statusLoading, error: statusError, degraded: statusDegraded, refetch } = useServerStatus(5000);
  const [stats, setStats] = useState<SystemStats | null>(null);
  const [statsError, setStatsError] = useState('');
  const [recentCrashes, setRecentCrashes] = useState<CrashEvent[]>([]);
  const [actionLoading, setActionLoading] = useState('');
  const [actionFeedback, setActionFeedback] = useState<{ type: 'success' | 'error'; message: string } | null>(null);

  useEffect(() => {
    apiGet<SystemStats>('/api/stats/system').then((res) => {
      if (res.success && res.data) {
        setStats(res.data);
        setStatsError('');
      } else {
        setStats(null);
        setStatsError(res.error ?? 'System stats unavailable');
      }
    });
    apiGet<{ events: CrashEvent[] }>('/api/crashes?limit=5&status=active').then((res) => {
      if (res.success && res.data) setRecentCrashes(res.data.events);
    });
  }, []);

  const handleServerAction = async (action: 'start' | 'stop' | 'restart') => {
    setActionLoading(action);
    setActionFeedback(null);
    try {
      const result = await apiPost<{ message: string }>(`/api/server/${action}`);
      if (result.success) {
        setActionFeedback({
          type: 'success',
          message: result.data?.message ?? `Server ${action} command completed`,
        });
        setTimeout(refetch, 2000);
      } else {
        setActionFeedback({
          type: 'error',
          message: result.error ?? result.data?.message ?? `Server ${action} command failed`,
        });
      }
    } finally {
      setActionLoading('');
    }
  };

  const isAdmin = user?.role === 'admin';

  return (
    <AppShell>
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-bold">Dashboard</h1>
          <p className="text-muted-foreground">Server overview and quick actions</p>
        </div>

        {/* Server Status + Controls */}
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
          <Card className="col-span-2">
            <CardHeader className="flex flex-row items-center justify-between pb-2">
              <CardTitle className="text-base font-medium">Server Status</CardTitle>
              {status && <StatusBadge running={status.running} />}
            </CardHeader>
            <CardContent>
              {statusDegraded && (
                <div className="mb-3 rounded-md border border-yellow-800 bg-yellow-900/20 px-3 py-2 text-xs text-yellow-300">
                  Control-plane degraded: {statusError ?? 'Helper dependency unavailable'}
                </div>
              )}
              {statusLoading ? (
                <p className="text-sm text-muted-foreground">Loading...</p>
              ) : status ? (
                <div className="space-y-2 text-sm">
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">PID</span>
                    <span>{status.pid ?? 'N/A'}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Uptime</span>
                    <span>{status.uptime ?? 'N/A'}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Service</span>
                    <span className="font-mono text-xs">{status.serviceName}</span>
                  </div>
                  {actionFeedback && (
                    <div
                      className={
                        actionFeedback.type === 'success'
                          ? 'rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-800'
                          : 'rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-800'
                      }
                    >
                      {actionFeedback.message}
                    </div>
                  )}
                  {isAdmin && (
                    <div className="flex gap-2 pt-3">
                      {!status.running ? (
                        <Button
                          size="sm"
                          variant="success"
                          disabled={!!actionLoading}
                          onClick={() => void handleServerAction('start')}
                        >
                          <Play className="mr-1 h-3 w-3" />
                          Start
                        </Button>
                      ) : (
                        <>
                          <ConfirmDialog
                            title="Stop Server"
                            description="This will gracefully stop the Hytale server. Players will be disconnected."
                            confirmLabel="Stop"
                            variant="destructive"
                            onConfirm={() => handleServerAction('stop')}
                          >
                            <Button size="sm" variant="destructive" disabled={!!actionLoading}>
                              <Square className="mr-1 h-3 w-3" />
                              Stop
                            </Button>
                          </ConfirmDialog>
                          <ConfirmDialog
                            title="Restart Server"
                            description="This will restart the Hytale server. Players will be briefly disconnected."
                            confirmLabel="Restart"
                            onConfirm={() => handleServerAction('restart')}
                          >
                            <Button size="sm" variant="warning" disabled={!!actionLoading}>
                              <RotateCcw className="mr-1 h-3 w-3" />
                              Restart
                            </Button>
                          </ConfirmDialog>
                        </>
                      )}
                    </div>
                  )}
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">
                  {statusError ? `Unable to fetch status: ${statusError}` : 'Unable to fetch status'}
                </p>
              )}
            </CardContent>
          </Card>

          {/* System Stats */}
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="flex items-center gap-2 text-base font-medium">
                <Cpu className="h-4 w-4" /> CPU
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-3xl font-bold">{stats?.cpuUsagePercent ?? '--'}%</div>
              {statsError && <p className="text-xs text-yellow-400">{statsError}</p>}
              <div className="mt-2 h-2 rounded-full bg-secondary">
                <div
                  className="h-2 rounded-full bg-primary transition-all"
                  style={{ width: `${stats?.cpuUsagePercent ?? 0}%` }}
                />
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="flex items-center gap-2 text-base font-medium">
                <MemoryStick className="h-4 w-4" /> Memory
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-3xl font-bold">{stats?.memoryUsagePercent ?? '--'}%</div>
              <p className="text-xs text-muted-foreground">
                {stats ? `${stats.memoryUsedMb} / ${stats.memoryTotalMb} MB` : '--'}
              </p>
              <div className="mt-2 h-2 rounded-full bg-secondary">
                <div
                  className="h-2 rounded-full bg-primary transition-all"
                  style={{ width: `${stats?.memoryUsagePercent ?? 0}%` }}
                />
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Disk + Recent Warnings */}
        <div className="grid gap-4 md:grid-cols-2">
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="flex items-center gap-2 text-base font-medium">
                <HardDrive className="h-4 w-4" /> Disk Usage
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-3xl font-bold">{stats?.diskUsagePercent ?? '--'}%</div>
              <p className="text-xs text-muted-foreground">
                {stats ? `${stats.diskUsedGb} / ${stats.diskTotalGb} GB` : '--'}
              </p>
              <div className="mt-2 h-2 rounded-full bg-secondary">
                <div
                  className="h-2 rounded-full bg-primary transition-all"
                  style={{ width: `${stats?.diskUsagePercent ?? 0}%` }}
                />
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="flex items-center gap-2 text-base font-medium">
                <AlertTriangle className="h-4 w-4" /> Recent Warnings
              </CardTitle>
            </CardHeader>
            <CardContent>
              {recentCrashes.length === 0 ? (
                <p className="text-sm text-muted-foreground">No recent warnings</p>
              ) : (
                <div className="space-y-2">
                  {recentCrashes.map((event) => (
                    <div key={event.id} className="flex items-center justify-between text-sm">
                      <div className="flex items-center gap-2">
                        <SeverityBadge severity={event.severity} />
                        <span className="truncate max-w-[200px]">{event.summary}</span>
                      </div>
                      <span className="text-xs text-muted-foreground">
                        {new Date(event.detectedAt).toLocaleDateString()}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    </AppShell>
  );
}
