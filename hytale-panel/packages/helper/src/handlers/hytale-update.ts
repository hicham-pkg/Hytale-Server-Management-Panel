import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { HelperConfig } from '../config';

const execFileAsync = promisify(execFile);

const TRIGGER_BIN = '/usr/local/lib/hytale-panel/hytale-server-updater-trigger';
const SUDO_BIN = '/usr/bin/sudo';
const UUID_V4_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const JOB_CREATION_LOCK_DIR = '.job-create.lock';
const JOB_CREATION_LOCK_STALE_MS = 5 * 60 * 1000;
const RUNNING_STATUS_GRACE_MS = 2 * 60 * 1000;

export type HytaleUpdateAction = 'check' | 'download' | 'apply' | 'update-now' | 'cancel';

export interface HytaleUpdateStartResult {
  success: boolean;
  jobId?: string;
  error?: string;
}

function ensureJobDir(jobsDir: string, jobId: string): string {
  const jobDir = path.join(jobsDir, jobId);
  fs.mkdirSync(jobDir, { recursive: true, mode: 0o770 });
  return jobDir;
}

function tryAcquireJobCreationLock(jobsDir: string): (() => void) | null {
  fs.mkdirSync(jobsDir, { recursive: true, mode: 0o770 });
  const lockDir = path.join(jobsDir, JOB_CREATION_LOCK_DIR);
  const acquire = () => {
    fs.mkdirSync(lockDir, { mode: 0o770 });
    fs.writeFileSync(
      path.join(lockDir, 'owner.json'),
      JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }) + '\n',
      { mode: 0o660 },
    );
  };

  try {
    acquire();
  } catch (err) {
    const nodeErr = err as NodeJS.ErrnoException;
    if (nodeErr.code !== 'EEXIST') throw err;
    try {
      const ageMs = Date.now() - fs.statSync(lockDir).mtimeMs;
      if (ageMs > JOB_CREATION_LOCK_STALE_MS) {
        fs.rmSync(lockDir, { recursive: true, force: true });
        acquire();
      } else {
        return null;
      }
    } catch (retryErr) {
      const retryNodeErr = retryErr as NodeJS.ErrnoException;
      if (retryNodeErr.code === 'EEXIST') return null;
      throw retryErr;
    }
  }

  return () => fs.rmSync(lockDir, { recursive: true, force: true });
}

function getRunningStatusAgeMs(statusPath: string, parsed: { startedAt?: unknown }): number {
  if (typeof parsed.startedAt === 'string') {
    const startedMs = Date.parse(parsed.startedAt);
    if (Number.isFinite(startedMs)) return Date.now() - startedMs;
  }
  return Date.now() - fs.statSync(statusPath).mtimeMs;
}

async function unitIsActive(jobId: string): Promise<boolean> {
  try {
    await execFileAsync(SUDO_BIN, ['-n', TRIGGER_BIN, 'is-active', jobId], { timeout: 5_000 });
    return true;
  } catch {
    return false;
  }
}

async function isAnyJobRunning(jobsDir: string): Promise<boolean> {
  if (!fs.existsSync(jobsDir)) return false;
  const entries = fs.readdirSync(jobsDir, { withFileTypes: true });
  for (const ent of entries) {
    if (!ent.isDirectory() || !UUID_V4_REGEX.test(ent.name)) continue;
    const statusPath = path.join(jobsDir, ent.name, 'status.json');
    if (!fs.existsSync(statusPath)) continue;
    try {
      const parsed = JSON.parse(fs.readFileSync(statusPath, 'utf8')) as { status?: string; startedAt?: unknown };
      if (parsed.status === 'running') {
        if (getRunningStatusAgeMs(statusPath, parsed) < RUNNING_STATUS_GRACE_MS) return true;
        if (await unitIsActive(ent.name)) return true;
      }
    } catch {
      // Ignore malformed historical job files so the operator can recover.
    }
  }
  return false;
}

async function startUnit(jobId: string): Promise<void> {
  await execFileAsync(SUDO_BIN, ['-n', TRIGGER_BIN, 'start', jobId], { timeout: 10_000 });
}

function writeFailedToStartStatus(jobDir: string, action: HytaleUpdateAction, error: string): void {
  const statusPath = path.join(jobDir, 'status.json');
  let status: Record<string, unknown> = {};
  try {
    status = JSON.parse(fs.readFileSync(statusPath, 'utf8')) as Record<string, unknown>;
  } catch {
    // write minimal terminal status below
  }
  fs.writeFileSync(
    statusPath,
    JSON.stringify(
      {
        jobId: status.jobId,
        kind: 'hytale-update',
        action,
        step: 0,
        stepName: 'queued',
        totalSteps: 1,
        status: 'failed',
        updateStatus: 'failed',
        startedAt: status.startedAt ?? new Date().toISOString(),
        endedAt: new Date().toISOString(),
        error,
      },
      null,
      2,
    ) + '\n',
    { mode: 0o660 },
  );
}

export async function hytaleUpdateStart(
  config: HelperConfig,
  action: HytaleUpdateAction,
): Promise<HytaleUpdateStartResult> {
  if (!config.hytaleUpdateEnabled) {
    return { success: false, error: 'Hytale server updates are disabled (HYTALE_UPDATE_ENABLED=false)' };
  }

  const releaseLock = tryAcquireJobCreationLock(config.hytaleUpdateJobsDir);
  if (!releaseLock) {
    return { success: false, error: 'Another Hytale update job is already being queued' };
  }

  let jobDir: string | undefined;
  try {
    if (await isAnyJobRunning(config.hytaleUpdateJobsDir)) {
      return { success: false, error: 'Another Hytale update job is already running' };
    }

    const jobId = crypto.randomUUID();
    if (!UUID_V4_REGEX.test(jobId)) {
      return { success: false, error: 'failed to generate job id' };
    }

    jobDir = ensureJobDir(config.hytaleUpdateJobsDir, jobId);
    const createdAt = new Date().toISOString();
    const spec = {
      kind: 'hytale-update' as const,
      action,
      jobId,
      createdAt,
    };
    fs.writeFileSync(path.join(jobDir, 'spec.json'), JSON.stringify(spec, null, 2) + '\n', { mode: 0o660 });
    fs.writeFileSync(
      path.join(jobDir, 'status.json'),
      JSON.stringify({
        jobId,
        kind: 'hytale-update',
        action,
        step: 0,
        stepName: 'queued',
        totalSteps: 1,
        status: 'running',
        updateStatus: action === 'cancel' ? 'unknown' : 'checking',
        startedAt: createdAt,
        endedAt: null,
        error: null,
      }) + '\n',
      { mode: 0o660 },
    );
    fs.writeFileSync(path.join(jobDir, 'logs.txt'), '', { mode: 0o660 });

    await startUnit(jobId);
    return { success: true, jobId };
  } catch (err) {
    const message = `Failed to start Hytale update job: ${(err as Error).message.slice(0, 200)}`;
    if (jobDir) writeFailedToStartStatus(jobDir, action, message);
    return { success: false, error: message };
  } finally {
    releaseLock();
  }
}
