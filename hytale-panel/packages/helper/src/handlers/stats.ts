import * as fs from 'fs/promises';
import { safeExec } from '../utils/command';
import type { HelperConfig } from '../config';
import { getManagedRuntimeProcess } from './server-control';

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

interface CpuSnapshot {
  idle: number;
  total: number;
}

let previousCpuSnapshot: CpuSnapshot | null = null;

function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 100) return 100;
  return Math.round(value);
}

async function readCpuSnapshot(): Promise<CpuSnapshot> {
  const statContent = await fs.readFile('/proc/stat', 'utf-8');
  const cpuLine = statContent.split('\n')[0] ?? '';
  const cpuParts = cpuLine
    .trim()
    .split(/\s+/)
    .slice(1)
    .map((part) => Number.parseInt(part, 10))
    .filter((value) => Number.isFinite(value));

  const idle = (cpuParts[3] ?? 0) + (cpuParts[4] ?? 0);
  const total = cpuParts.reduce((sum, value) => sum + value, 0);

  return { idle, total };
}

function computeCpuUsagePercent(previous: CpuSnapshot, current: CpuSnapshot): number {
  const deltaTotal = current.total - previous.total;
  const deltaIdle = current.idle - previous.idle;
  if (deltaTotal <= 0) {
    return 0;
  }

  const usage = ((deltaTotal - deltaIdle) / deltaTotal) * 100;
  return clampPercent(usage);
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Get system-level stats from /proc and df.
 */
export async function getSystemStats(): Promise<{ success: boolean; stats?: SystemStatsResult; error?: string }> {
  try {
    const currentCpuSnapshot = await readCpuSnapshot();
    let cpuUsagePercent = 0;
    if (previousCpuSnapshot) {
      cpuUsagePercent = computeCpuUsagePercent(previousCpuSnapshot, currentCpuSnapshot);
      previousCpuSnapshot = currentCpuSnapshot;
    } else {
      // First invocation has no prior sample; take a short interval sample
      // so we still report a delta-based CPU percentage.
      await sleep(250);
      const secondSample = await readCpuSnapshot();
      cpuUsagePercent = computeCpuUsagePercent(currentCpuSnapshot, secondSample);
      previousCpuSnapshot = secondSample;
    }

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
    const runtime = await getManagedRuntimeProcess(config);
    if (!runtime) {
      return {
        success: true,
        stats: { pid: null, cpuPercent: null, memoryMb: null, uptime: null },
      };
    }

    const pid = runtime.pid;

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
