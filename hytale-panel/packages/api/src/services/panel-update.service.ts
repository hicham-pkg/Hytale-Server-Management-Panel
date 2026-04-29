import * as fs from 'node:fs';
import * as path from 'node:path';
import { callHelper } from './helper-client';
import { getConfig } from '../config';

/**
 * Panel updater (V2) — API-side service.
 *
 * Split of duties:
 *   - START / ROLLBACK / CANCEL_STAGING go through helper RPC (they need
 *     privileged systemd actions).
 *   - STATUS / LOGS / LIST / LATEST read from the read-only bind mount of
 *     /opt/hytale-panel-data/update-jobs that lives in the API container.
 *
 * Why the split: precisely while the updater is running, the helper itself
 * is being torn down and restarted (step "deploy helper"). If status/logs
 * lookups went through helper RPC, the dashboard would lose visibility at
 * the most stressful moment. Reading files directly is resilient.
 */

export interface PanelUpdateJobStatus {
  jobId: string;
  kind: 'update' | 'rollback';
  step: number;
  stepName: string;
  totalSteps: number;
  status: 'running' | 'success' | 'failed';
  startedAt: string;
  endedAt: string | null;
  error: string | null;
}

export interface PanelUpdateJobSummary extends PanelUpdateJobStatus {
  // From spec.json
  targetTag?: string;
  currentVersion?: string;
}

const UUID_V4_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function safeJobDir(jobId: string): string | null {
  if (!UUID_V4_REGEX.test(jobId)) return null;
  const config = getConfig();
  const root = path.resolve(config.panelUpdateJobsDir);
  const dir = path.resolve(root, jobId);
  // Defense in depth: enforce the resolved dir is still a direct child.
  if (path.dirname(dir) !== root) return null;
  return dir;
}

export async function startPanelUpdate(params: {
  targetTag: string;
  downloadUrl: string;
  tarballType: 'tar.gz' | 'zip';
  expectedSha256?: string | null;
  currentVersion: string;
}): Promise<{ success: boolean; jobId?: string; error?: string }> {
  const config = getConfig();
  if (!config.panelUpdateInstallEnabled) {
    return { success: false, error: 'Panel updates are disabled' };
  }
  const result = await callHelper('panelUpdate.start', params, { timeoutMs: 15_000 });
  if (!result.success) {
    return { success: false, error: result.error ?? 'Helper rejected update start' };
  }
  const data = (result.data ?? {}) as { jobId?: string };
  return { success: true, jobId: data.jobId };
}

export async function rollbackPanelUpdate(params: {
  backupPath?: string;
}): Promise<{ success: boolean; jobId?: string; error?: string }> {
  const config = getConfig();
  if (!config.panelUpdateInstallEnabled) {
    return { success: false, error: 'Panel updates are disabled' };
  }
  const result = await callHelper('panelUpdate.rollback', params, { timeoutMs: 15_000 });
  if (!result.success) {
    return { success: false, error: result.error ?? 'Helper rejected rollback' };
  }
  const data = (result.data ?? {}) as { jobId?: string };
  return { success: true, jobId: data.jobId };
}

export function readJobStatus(jobId: string): PanelUpdateJobStatus | null {
  const dir = safeJobDir(jobId);
  if (!dir) return null;
  const statusFile = path.join(dir, 'status.json');
  if (!fs.existsSync(statusFile)) return null;
  try {
    const raw = fs.readFileSync(statusFile, 'utf8');
    const parsed = JSON.parse(raw) as Partial<PanelUpdateJobStatus>;
    if (!parsed || !parsed.jobId || parsed.jobId !== jobId) return null;
    return parsed as PanelUpdateJobStatus;
  } catch {
    return null;
  }
}

/**
 * Tail-read the logs file. cursor=0 returns the full log up to the cap.
 * Always returns at most config.panelUpdateMaxLogBytes regardless of cursor
 * so a misbehaving (huge) logs.txt can't blow up the API response.
 */
export function readJobLogs(
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
  const cap = config.panelUpdateMaxLogBytes;
  const wantedEnd = total;
  const start = wantedEnd - startCursor > cap ? wantedEnd - cap : startCursor;
  const length = wantedEnd - start;
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

export function listJobs(limit = 20): PanelUpdateJobSummary[] {
  const config = getConfig();
  const root = config.panelUpdateJobsDir;
  if (!fs.existsSync(root)) return [];
  const entries = fs
    .readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isDirectory() && UUID_V4_REGEX.test(e.name));
  const summaries: PanelUpdateJobSummary[] = [];
  for (const ent of entries) {
    const status = readJobStatus(ent.name);
    if (!status) continue;
    let targetTag: string | undefined;
    let currentVersion: string | undefined;
    try {
      const spec = JSON.parse(fs.readFileSync(path.join(root, ent.name, 'spec.json'), 'utf8')) as
        Partial<PanelUpdateJobSummary> & { targetTag?: string; currentVersion?: string };
      targetTag = spec.targetTag;
      currentVersion = spec.currentVersion;
    } catch { /* spec missing — show only status fields */ }
    summaries.push({ ...status, targetTag, currentVersion });
  }
  summaries.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  return summaries.slice(0, limit);
}

export function latestJob(): PanelUpdateJobSummary | null {
  const list = listJobs(1);
  return list[0] ?? null;
}
