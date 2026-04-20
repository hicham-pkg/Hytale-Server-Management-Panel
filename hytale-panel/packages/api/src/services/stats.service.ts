import { callHelper } from './helper-client';
import type { SystemStats, ProcessStats } from '@hytale-panel/shared';

export async function getSystemStats(): Promise<SystemStats> {
  const result = await callHelper('stats.system');
  if (!result.success) {
    throw new Error(result.error ?? 'Helper system stats request failed');
  }
  return result.data as SystemStats;
}

export async function getProcessStats(): Promise<ProcessStats> {
  const result = await callHelper('stats.process');
  if (!result.success) {
    throw new Error(result.error ?? 'Helper process stats request failed');
  }
  return result.data as ProcessStats;
}
