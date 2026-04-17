import * as fs from 'fs/promises';
import { safeExec } from '../utils/command';
import type { HelperConfig } from '../config';

export interface SystemStatsResult {
  cpuUsagePercent: number;
  memoryUsedMb: number;
  memoryTotalMb: number;
  memoryUsagePercent: number;
  diskUsedGb: number;
  diskTotalGb: number;
  diskUsagePercent: number;
}

export interface ProcessStatsResult {
  pid: number | null;
  cpuPercent: number | null;
  memoryMb: number | null;
  uptime: string | null;
}

/**
 * Get system-level stats from /proc and df.
 */
export async function getSystemStats(): Promise<{ success: boolean; stats?: SystemStatsResult; error?: string }> {
  try {
    // CPU usage from /proc/stat (snapshot-based approximation)
    const statContent = await fs.readFile('/proc/stat', 'utf-8');
    const cpuLine = statContent.split('\n')[0];
    const cpuParts = cpuLine.split(/\s+/).slice(1).map(Number);
    const idle = cpuParts[3] + (cpuParts[4] || 0);
    const total = cpuParts.reduce((a, b) => a + b, 0);
    // This is a rough estimate; for accurate CPU, we'd need two samples
    const cpuUsagePercent = total > 0 ? Math.round(((total - idle) / total) * 100) : 0;

    // Memory from /proc/meminfo
    const memContent = await fs.readFile('/proc/meminfo', 'utf-8');
    const memTotal = parseInt(memContent.match(/MemTotal:\s+(\d+)/)?.[1] ?? '0', 10);
    const memAvailable = parseInt(memContent.match(/MemAvailable:\s+(\d+)/)?.[1] ?? '0', 10);
    const memTotalMb = Math.round(memTotal / 1024);
    const memUsedMb = Math.round((memTotal - memAvailable) / 1024);
    const memPercent = memTotal > 0 ? Math.round(((memTotal - memAvailable) / memTotal) * 100) : 0;

    // Disk usage from df
    const dfResult = await safeExec('/usr/bin/df', ['-BG', '--output=size,used,pcent', '/']);
    const dfLines = dfResult.stdout.trim().split('\n');
    let diskTotalGb = 0;
    let diskUsedGb = 0;
    let diskPercent = 0;
    if (dfLines.length >= 2) {
      const parts = dfLines[1].trim().split(/\s+/);
      diskTotalGb = parseInt(parts[0], 10) || 0;
      diskUsedGb = parseInt(parts[1], 10) || 0;
      diskPercent = parseInt(parts[2], 10) || 0;
    }

    return {
      success: true,
      stats: {
        cpuUsagePercent,
        memoryUsedMb: memUsedMb,
        memoryTotalMb: memTotalMb,
        memoryUsagePercent: memPercent,
        diskUsedGb,
        diskTotalGb,
        diskUsagePercent: diskPercent,
      },
    };
  } catch (err) {
    return { success: false, error: `Stats error: ${String(err).slice(0, 200)}` };
  }
}

/**
 * Get Hytale process stats.
 */
export async function getProcessStats(config: HelperConfig): Promise<{ success: boolean; stats?: ProcessStatsResult; error?: string }> {
  try {
    // Find PID
    const pgrepResult = await safeExec('/usr/bin/pgrep', ['-f', 'hytale']);
    if (pgrepResult.exitCode !== 0 || !pgrepResult.stdout.trim()) {
      return {
        success: true,
        stats: { pid: null, cpuPercent: null, memoryMb: null, uptime: null },
      };
    }

    const pid = parseInt(pgrepResult.stdout.trim().split('\n')[0], 10);

    // Get process stats via ps
    const psResult = await safeExec('/usr/bin/ps', [
      '-p', String(pid),
      '-o', 'pcpu=,rss=,etime=',
    ]);

    if (psResult.exitCode !== 0) {
      return {
        success: true,
        stats: { pid, cpuPercent: null, memoryMb: null, uptime: null },
      };
    }

    const parts = psResult.stdout.trim().split(/\s+/);
    const cpuPercent = parseFloat(parts[0]) || 0;
    const memoryKb = parseInt(parts[1], 10) || 0;
    const uptime = parts[2] || null;

    return {
      success: true,
      stats: {
        pid,
        cpuPercent: Math.round(cpuPercent * 10) / 10,
        memoryMb: Math.round(memoryKb / 1024),
        uptime,
      },
    };
  } catch (err) {
    return { success: false, error: `Process stats error: ${String(err).slice(0, 200)}` };
  }
}