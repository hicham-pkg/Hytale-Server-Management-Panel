import * as fs from 'node:fs';
import * as path from 'node:path';
import { callHelper } from './helper-client';
import { getConfig } from '../config';

export type HytaleUpdateAction = 'check' | 'download' | 'apply' | 'update-now' | 'cancel';
export type HytaleUpdateStatusValue =
  | 'unknown'
  | 'checking'
  | 'up_to_date'
  | 'update_available'
  | 'downloading'
  | 'staged'
  | 'applying'
  | 'succeeded'
  | 'failed';

export interface HytaleUpdateJobStatus {
  jobId: string;
  kind: 'hytale-update';
  action: HytaleUpdateAction;
  step: number;
  stepName: string;
  totalSteps: number;
  status: 'running' | 'success' | 'failed';
  updateStatus: HytaleUpdateStatusValue;
  startedAt: string;
  endedAt: string | null;
  error: string | null;
}

export interface HytaleUpdateOverview {
  enabled: boolean;
  status: HytaleUpdateStatusValue;
  latestJob: HytaleUpdateJobStatus | null;
  lastChecked: string | null;
  currentVersion: string | null;
  latestVersion: string | null;
  patchline: string | null;
}

const UUID_V4_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function safeJobDir(jobId: string): string | null {
  if (!UUID_V4_REGEX.test(jobId)) return null;
  const config = getConfig();
  const root = path.resolve(config.hytaleUpdateJobsDir);
  const dir = path.resolve(root, jobId);
  if (path.dirname(dir) !== root) return null;
  return dir;
}

export async function startHytaleUpdateJob(action: HytaleUpdateAction): Promise<{ success: boolean; jobId?: string; error?: string }> {
  const config = getConfig();
  if (!config.hytaleUpdateEnabled) {
    return { success: false, error: 'Hytale server updates are disabled' };
  }
  const result = await callHelper('hytaleUpdate.start', { action }, { timeoutMs: 15_000 });
  if (!result.success) {
    return { success: false, error: result.error ?? 'Helper rejected Hytale update job' };
  }
  const data = (result.data ?? {}) as { jobId?: string };
  return { success: true, jobId: data.jobId };
}

export function readHytaleUpdateJobStatus(jobId: string): HytaleUpdateJobStatus | null {
  const dir = safeJobDir(jobId);
  if (!dir) return null;
  const statusFile = path.join(dir, 'status.json');
  if (!fs.existsSync(statusFile)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(statusFile, 'utf8')) as Partial<HytaleUpdateJobStatus>;
    if (!parsed || parsed.jobId !== jobId || parsed.kind !== 'hytale-update') return null;
    return parsed as HytaleUpdateJobStatus;
  } catch {
    return null;
  }
}

export function readHytaleUpdateJobLogs(
  jobId: string,
  cursor: number,
): { content: string; nextCursor: number; totalBytes: number } | null {
  const dir = safeJobDir(jobId);
  if (!dir) return null;
  const logFile = path.join(dir, 'logs.txt');
  if (!fs.existsSync(logFile)) {
    return { content: '', nextCursor: 0, totalBytes: 0 };
  }
  const config = getConfig();
  const stat = fs.statSync(logFile);
  const total = stat.size;
  const startCursor = Math.max(0, Math.min(cursor, total));
  const cap = config.hytaleUpdateMaxLogBytes;
  const start = total - startCursor > cap ? total - cap : startCursor;
  const length = total - start;
  if (length <= 0) {
    return { content: '', nextCursor: total, totalBytes: total };
  }
  const fd = fs.openSync(logFile, 'r');
  try {
    const buf = Buffer.alloc(length);
    fs.readSync(fd, buf, 0, length, start);
    return { content: buf.toString('utf8'), nextCursor: total, totalBytes: total };
  } finally {
    fs.closeSync(fd);
  }
}

export function listHytaleUpdateJobs(limit = 20): HytaleUpdateJobStatus[] {
  const config = getConfig();
  const root = config.hytaleUpdateJobsDir;
  if (!fs.existsSync(root)) return [];
  const entries = fs
    .readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && UUID_V4_REGEX.test(entry.name));
  const jobs: HytaleUpdateJobStatus[] = [];
  for (const entry of entries) {
    const status = readHytaleUpdateJobStatus(entry.name);
    if (status) jobs.push(status);
  }
  jobs.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  return jobs.slice(0, limit);
}

export function latestHytaleUpdateJob(): HytaleUpdateJobStatus | null {
  return listHytaleUpdateJobs(1)[0] ?? null;
}

export function getHytaleUpdateOverview(): HytaleUpdateOverview {
  const config = getConfig();
  const latestJob = latestHytaleUpdateJob();
  return {
    enabled: config.hytaleUpdateEnabled,
    status: latestJob?.updateStatus ?? 'unknown',
    latestJob,
    lastChecked: latestJob?.startedAt ?? null,
    currentVersion: null,
    latestVersion: null,
    patchline: null,
  };
}
