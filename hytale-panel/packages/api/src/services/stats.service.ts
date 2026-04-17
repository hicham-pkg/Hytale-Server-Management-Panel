import { callHelper } from './helper-client';
import type { SystemStats, ProcessStats } from '@hytale-panel/shared';

export async function getSystemStats(): Promise<SystemStats> {
  const result = await callHelper('stats.system');
  if (!result.success) {
    return {
      cpuUsagePercent: 0,
      memoryUsedMb: 0,
      memoryTotalMb: 0,
      memoryUsagePercent: 0,
      diskUsedGb: 0,
      diskTotalGb: 0,
      diskUsagePercent: 0,
    };
  }
  return result.data as SystemStats;
}

export async function getProcessStats(): Promise<ProcessStats> {
  const result = await callHelper('stats.process');
  if (!result.success) {
    return { pid: null, cpuPercent: null, memoryMb: null, uptime: null };
  }
  return result.data as ProcessStats;
}