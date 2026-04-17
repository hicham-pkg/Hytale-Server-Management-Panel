import React, { useState, useEffect, useCallback } from 'react';
import { useAuth } from '@/lib/auth-context';
import { server, stats } from '@/lib/api';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Progress } from '@/components/ui/progress';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import { useToast } from '@/hooks/use-toast';
import {
  Activity,
  Cpu,
  HardDrive,
  MemoryStick,
  Play,
  Power,
  RefreshCw,
  Square,
  Users,
  Clock,
  Loader2,
  AlertTriangle,
} from 'lucide-react';

interface ServerStatus {
  running: boolean;
  pid: number | null;
  uptime: string | null;
  lastRestart: string | null;
  playerCount: number | null;
  serviceName: string;
  error?: string;
}

interface SystemStats {
  cpuUsagePercent: number;
  memoryUsedMb: number;
  memoryTotalMb: number;
  memoryUsagePercent: number;
  diskUsedGb: number;
  diskTotalGb: number;
  diskUsagePercent: number;
}

interface ProcessStats {
  pid: number | null;
  cpuPercent: number | null;
  memoryMb: number | null;
  uptime: string | null;
}

export default function DashboardPage() {
  const { isAdmin } = useAuth();
  const { toast } = useToast();

  const [status, setStatus] = useState<ServerStatus | null>(null);
  const [sysStats, setSysStats] = useState<SystemStats | null>(null);
  const [procStats, setProcStats] = useState<ProcessStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState<string | null>(null);

  const fetchData = useCallback(async () => {
    try {
      const [statusRes, sysRes, procRes] = await Promise.all([
        server.status(),
        stats.system(),
        stats.process(),
      ]);
      if (statusRes.data) setStatus(statusRes.data);
      if (sysRes.data) setSysStats(sysRes.data);
      if (procRes.data) setProcStats(procRes.data);
    } catch {
      // Silently handle — data may be partially available
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchData();
    const interval = setInterval(fetchData, 5000);
    return () => clearInterval(interval);
  }, [fetchData]);

  const handleAction = async (action: 'start' | 'stop' | 'restart') => {
    setActionLoading(action);
    try {
      const fn = action === 'start' ? server.start : action === 'stop' ? server.stop : server.restart;
      const res = await fn();
      toast({
        title: res.success ? 'Success' : 'Error',
        description: res.data?.message || res.error || `Server ${action} ${res.success ? 'initiated' : 'failed'}`,
        variant: res.success ? 'default' : 'destructive',
      });
      setTimeout(fetchData, 2000);
    } catch {
      toast({ title: 'Error', description: 'Failed to reach server', variant: 'destructive' });
    } finally {
      setActionLoading(null);
    }
  };

  const getProgressColor = (value: number) => {
    if (value >= 90) return 'bg-red-500';
    if (value >= 70) return 'bg-amber-500';
    return 'bg-indigo-500';
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="h-8 w-8 animate-spin text-indigo-400" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-white">Dashboard</h1>
        <Button
          variant="ghost"
          size="sm"
          onClick={fetchData}
          className="text-slate-400 hover:text-white"
        >
          <RefreshCw className="h-4 w-4 mr-1" />
          Refresh
        </Button>
      </div>

      {/* Server Status + Controls */}
      <Card className="bg-[#12121a] border-[#2a2a3e]">
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <CardTitle className="text-white flex items-center gap-2">
              <Activity className="h-5 w-5 text-indigo-400" />
              Server Status
            </CardTitle>
            <Badge
              className={`${
                status?.running
                  ? 'bg-green-500/15 text-green-400 border-green-500/30'
                  : 'bg-red-500/15 text-red-400 border-red-500/30'
              }`}
              variant="outline"
            >
              <span
                className={`inline-block h-2 w-2 rounded-full mr-1.5 ${
                  status?.running ? 'bg-green-400 animate-pulse' : 'bg-red-400'
                }`}
              />
              {status?.running ? 'Online' : 'Offline'}
            </Badge>
          </div>
        </CardHeader>
        <CardContent>
          {status?.error && (
            <div className="flex items-center gap-2 text-amber-400 text-sm bg-amber-500/10 p-3 rounded-md mb-4">
              <AlertTriangle className="h-4 w-4 flex-shrink-0" />
              <span>{status.error}</span>
            </div>
          )}

          <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-4">
            <div className="space-y-1">
              <p className="text-xs text-slate-500 uppercase tracking-wider">PID</p>
              <p className="text-sm text-white font-mono">{status?.pid ?? '—'}</p>
            </div>
            <div className="space-y-1">
              <p className="text-xs text-slate-500 uppercase tracking-wider">Uptime</p>
              <p className="text-sm text-white flex items-center gap-1">
                <Clock className="h-3 w-3 text-slate-500" />
                {status?.uptime ?? '—'}
              </p>
            </div>
            <div className="space-y-1">
              <p className="text-xs text-slate-500 uppercase tracking-wider">Players</p>
              <p className="text-sm text-white flex items-center gap-1">
                <Users className="h-3 w-3 text-slate-500" />
                {status?.playerCount ?? '—'}
              </p>
            </div>
            <div className="space-y-1">
              <p className="text-xs text-slate-500 uppercase tracking-wider">Last Restart</p>
              <p className="text-sm text-white">
                {status?.lastRestart ? new Date(status.lastRestart).toLocaleString() : '—'}
              </p>
            </div>
          </div>

          {/* Controls (admin only) */}
          {isAdmin && (
            <div className="flex gap-2 pt-2 border-t border-[#2a2a3e]">
              <Button
                size="sm"
                disabled={!!actionLoading || status?.running === true}
                onClick={() => handleAction('start')}
                className="bg-green-600 hover:bg-green-700 text-white"
              >
                {actionLoading === 'start' ? (
                  <Loader2 className="h-3 w-3 animate-spin mr-1" />
                ) : (
                  <Play className="h-3 w-3 mr-1" />
                )}
                Start
              </Button>

              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={!!actionLoading || status?.running === false}
                    className="border-red-500/30 text-red-400 hover:bg-red-500/10 hover:text-red-300"
                  >
                    <Square className="h-3 w-3 mr-1" />
                    Stop
                  </Button>
                </AlertDialogTrigger>
                <AlertDialogContent className="bg-[#12121a] border-[#2a2a3e]">
                  <AlertDialogHeader>
                    <AlertDialogTitle className="text-white">Stop Server?</AlertDialogTitle>
                    <AlertDialogDescription className="text-slate-400">
                      This will stop the Hytale server. All connected players will be disconnected.
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel className="bg-[#1a1a2e] border-[#2a2a3e] text-slate-300 hover:bg-[#2a2a3e]">
                      Cancel
                    </AlertDialogCancel>
                    <AlertDialogAction
                      onClick={() => handleAction('stop')}
                      className="bg-red-600 hover:bg-red-700 text-white"
                    >
                      {actionLoading === 'stop' && <Loader2 className="h-3 w-3 animate-spin mr-1" />}
                      Stop Server
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>

              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={!!actionLoading}
                    className="border-amber-500/30 text-amber-400 hover:bg-amber-500/10 hover:text-amber-300"
                  >
                    <RefreshCw className="h-3 w-3 mr-1" />
                    Restart
                  </Button>
                </AlertDialogTrigger>
                <AlertDialogContent className="bg-[#12121a] border-[#2a2a3e]">
                  <AlertDialogHeader>
                    <AlertDialogTitle className="text-white">Restart Server?</AlertDialogTitle>
                    <AlertDialogDescription className="text-slate-400">
                      This will restart the Hytale server. Players will be temporarily disconnected.
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel className="bg-[#1a1a2e] border-[#2a2a3e] text-slate-300 hover:bg-[#2a2a3e]">
                      Cancel
                    </AlertDialogCancel>
                    <AlertDialogAction
                      onClick={() => handleAction('restart')}
                      className="bg-amber-600 hover:bg-amber-700 text-white"
                    >
                      {actionLoading === 'restart' && <Loader2 className="h-3 w-3 animate-spin mr-1" />}
                      Restart Server
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            </div>
          )}
        </CardContent>
      </Card>

      {/* System Stats */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {/* CPU */}
        <Card className="bg-[#12121a] border-[#2a2a3e]">
          <CardContent className="pt-6">
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-2">
                <Cpu className="h-4 w-4 text-indigo-400" />
                <span className="text-sm text-slate-400">CPU Usage</span>
              </div>
              <span className="text-lg font-bold text-white">
                {sysStats?.cpuUsagePercent?.toFixed(1) ?? '—'}%
              </span>
            </div>
            <Progress
              value={sysStats?.cpuUsagePercent ?? 0}
              className="h-2 bg-[#1a1a2e]"
            />
            {procStats?.cpuPercent != null && (
              <p className="text-xs text-slate-500 mt-2">
                Server process: {procStats.cpuPercent.toFixed(1)}%
              </p>
            )}
          </CardContent>
        </Card>

        {/* Memory */}
        <Card className="bg-[#12121a] border-[#2a2a3e]">
          <CardContent className="pt-6">
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-2">
                <MemoryStick className="h-4 w-4 text-indigo-400" />
                <span className="text-sm text-slate-400">Memory</span>
              </div>
              <span className="text-lg font-bold text-white">
                {sysStats?.memoryUsagePercent?.toFixed(1) ?? '—'}%
              </span>
            </div>
            <Progress
              value={sysStats?.memoryUsagePercent ?? 0}
              className="h-2 bg-[#1a1a2e]"
            />
            <p className="text-xs text-slate-500 mt-2">
              {sysStats ? `${(sysStats.memoryUsedMb / 1024).toFixed(1)} / ${(sysStats.memoryTotalMb / 1024).toFixed(1)} GB` : '—'}
              {procStats?.memoryMb != null && ` · Server: ${procStats.memoryMb.toFixed(0)} MB`}
            </p>
          </CardContent>
        </Card>

        {/* Disk */}
        <Card className="bg-[#12121a] border-[#2a2a3e]">
          <CardContent className="pt-6">
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-2">
                <HardDrive className="h-4 w-4 text-indigo-400" />
                <span className="text-sm text-slate-400">Disk</span>
              </div>
              <span className="text-lg font-bold text-white">
                {sysStats?.diskUsagePercent?.toFixed(1) ?? '—'}%
              </span>
            </div>
            <Progress
              value={sysStats?.diskUsagePercent ?? 0}
              className="h-2 bg-[#1a1a2e]"
            />
            <p className="text-xs text-slate-500 mt-2">
              {sysStats ? `${sysStats.diskUsedGb.toFixed(1)} / ${sysStats.diskTotalGb.toFixed(1)} GB` : '—'}
            </p>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}