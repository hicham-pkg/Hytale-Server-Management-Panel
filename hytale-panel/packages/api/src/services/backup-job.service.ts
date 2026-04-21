import { randomUUID } from 'crypto';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import type { PoolClient } from 'pg';
import { getDb, getPool, schema } from '../db';
import * as backupService from './backup.service';
import { logAudit } from './audit.service';

const { backupJobs } = schema;

export type BackupJobType = 'create' | 'restore';
export type BackupJobStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'interrupted';

interface CreateBackupJobPayload {
  label?: string;
}

interface RestoreBackupJobPayload {
  backupId: string;
}

type BackupJobRequestPayload = CreateBackupJobPayload | RestoreBackupJobPayload;

export interface BackupJobView {
  id: string;
  type: BackupJobType;
  status: BackupJobStatus;
  requestPayload: Record<string, unknown>;
  resultPayload: Record<string, unknown> | null;
  error: string | null;
  requestedBy: string | null;
  workerId: string | null;
  leaseExpiresAt: string | null;
  lastHeartbeatAt: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  updatedAt: string;
}

const WORKER_POLL_INTERVAL_MS = 2_000;
const WORKER_LEASE_MS = 90_000;
const WORKER_HEARTBEAT_MS = 15_000;
const STALE_INTERRUPT_ERROR = 'Backup job interrupted by API restart or worker failure';
const STALE_RUNNING_LEASE_EXTENSION_MS = 30_000;
const BACKUP_JOB_EXECUTION_LOCK_KEY = 0x4854424a; // 'HTBJ'

let workerTimer: NodeJS.Timeout | null = null;
let workerCycleInFlight = false;
const workerId = `backup-worker-${process.pid}-${randomUUID().slice(0, 8)}`;

function mapBackupJobRow(row: typeof backupJobs.$inferSelect): BackupJobView {
  return {
    id: row.id,
    type: row.type as BackupJobType,
    status: row.status as BackupJobStatus,
    requestPayload: (row.requestPayload ?? {}) as Record<string, unknown>,
    resultPayload: (row.resultPayload as Record<string, unknown> | null) ?? null,
    error: row.error ?? null,
    requestedBy: row.requestedBy ?? null,
    workerId: row.workerId ?? null,
    leaseExpiresAt: row.leaseExpiresAt?.toISOString() ?? null,
    lastHeartbeatAt: row.lastHeartbeatAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    startedAt: row.startedAt?.toISOString() ?? null,
    finishedAt: row.finishedAt?.toISOString() ?? null,
    updatedAt: row.updatedAt.toISOString(),
  };
}

function clampLimit(limit: number | undefined): number {
  return Math.min(Math.max(limit ?? 20, 1), 100);
}

async function queueJob(
  type: BackupJobType,
  requestPayload: BackupJobRequestPayload,
  requestedBy: string
): Promise<BackupJobView> {
  const db = getDb();
  const [created] = await db
    .insert(backupJobs)
    .values({
      type,
      status: 'queued',
      requestPayload: requestPayload as Record<string, unknown>,
      requestedBy,
      updatedAt: new Date(),
    })
    .returning();

  return mapBackupJobRow(created);
}

export async function enqueueCreateBackupJob(label: string | undefined, requestedBy: string): Promise<BackupJobView> {
  return queueJob('create', label ? { label } : {}, requestedBy);
}

export async function enqueueRestoreBackupJob(backupId: string, requestedBy: string): Promise<BackupJobView> {
  return queueJob('restore', { backupId }, requestedBy);
}

export async function getBackupJob(jobId: string): Promise<BackupJobView | null> {
  const db = getDb();
  const [row] = await db.select().from(backupJobs).where(eq(backupJobs.id, jobId)).limit(1);
  return row ? mapBackupJobRow(row) : null;
}

export async function listBackupJobs(options?: {
  statuses?: BackupJobStatus[];
  limit?: number;
}): Promise<BackupJobView[]> {
  const db = getDb();
  const limit = clampLimit(options?.limit);
  const statuses = options?.statuses;
  const rows = statuses && statuses.length > 0
    ? await db
      .select()
      .from(backupJobs)
      .where(inArray(backupJobs.status, statuses))
      .orderBy(desc(backupJobs.createdAt))
      .limit(limit)
    : await db
      .select()
      .from(backupJobs)
      .orderBy(desc(backupJobs.createdAt))
      .limit(limit);

  return rows.map(mapBackupJobRow);
}

async function markJobInterrupted(
  jobId: string,
  requestedBy: string | null,
  type: BackupJobType,
  reason: string
): Promise<void> {
  await getDb()
    .update(backupJobs)
    .set({
      status: 'interrupted',
      error: reason,
      finishedAt: new Date(),
      leaseExpiresAt: null,
      lastHeartbeatAt: null,
      workerId: null,
      updatedAt: new Date(),
    })
    .where(eq(backupJobs.id, jobId));

  if (!requestedBy) {
    return;
  }

  await logAudit({
    userId: requestedBy,
    action: `backup.${type}.interrupted`,
    target: jobId,
    success: false,
    details: { reason },
  }).catch(() => undefined);
}

async function extendStaleRunningLease(jobId: string): Promise<void> {
  const leaseSeconds = Math.floor(STALE_RUNNING_LEASE_EXTENSION_MS / 1000);
  await getDb()
    .update(backupJobs)
    .set({
      leaseExpiresAt: sql`NOW() + make_interval(secs => ${leaseSeconds})`,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(backupJobs.id, jobId),
        eq(backupJobs.status, 'running')
      )
    );
}

async function reconcileStaleRunningJobs(): Promise<{ handled: number; unresolvedRunning: number }> {
  const db = getDb();
  const staleRows = await db
    .select({
      id: backupJobs.id,
      requestedBy: backupJobs.requestedBy,
      type: backupJobs.type,
      requestPayload: backupJobs.requestPayload,
    })
    .from(backupJobs)
    .where(
      and(
        eq(backupJobs.status, 'running'),
        sql`${backupJobs.leaseExpiresAt} IS NOT NULL`,
        sql`${backupJobs.leaseExpiresAt} < NOW()`
      )
    );

  if (staleRows.length === 0) {
    return { handled: 0, unresolvedRunning: 0 };
  }

  let handled = 0;
  let unresolvedRunning = 0;
  for (const row of staleRows) {
    const helperOperation: backupService.HelperBackupOperationLookup =
      await backupService.getBackupOperationStatus(row.id).catch(() => ({
        success: false,
        found: false,
        error: 'Helper operation lookup failed',
      }));

    const requestPayload = (row.requestPayload ?? {}) as Record<string, unknown>;
    const type = row.type as BackupJobType;

    if (helperOperation.success && helperOperation.found && helperOperation.status === 'succeeded') {
      if (type === 'create') {
        const backup = ((helperOperation.resultPayload ?? {}) as { backup?: Record<string, unknown> }).backup;
        await finalizeJobSuccess(
          row.id,
          helperOperation.resultPayload ?? {},
          row.requestedBy,
          'backup.create',
          typeof backup?.filename === 'string' ? backup.filename : undefined,
          {
            label: typeof requestPayload.label === 'string' ? requestPayload.label : null,
            sha256: typeof backup?.sha256 === 'string' ? backup.sha256 : null,
          }
        );
      } else {
        const backupId = typeof requestPayload.backupId === 'string' ? requestPayload.backupId : undefined;
        const resultPayload = helperOperation.resultPayload ?? {};
        await finalizeJobSuccess(
          row.id,
          resultPayload,
          row.requestedBy,
          'backup.restore',
          backupId,
          {
            safetyBackup:
              typeof (resultPayload as { safetyBackup?: unknown }).safetyBackup === 'string'
                ? (resultPayload as { safetyBackup: string }).safetyBackup
                : null,
          }
        );
      }
      handled += 1;
      continue;
    }

    if (helperOperation.success && helperOperation.found && helperOperation.status === 'failed') {
      const backupId = typeof requestPayload.backupId === 'string' ? requestPayload.backupId : undefined;
      await finalizeJobFailure(
        row.id,
        helperOperation.error ?? 'Backup operation failed',
        row.requestedBy,
        `backup.${type}`,
        type === 'restore' ? backupId : undefined,
        {}
      );
      handled += 1;
      continue;
    }

    if (helperOperation.success && helperOperation.found && helperOperation.status === 'running') {
      await extendStaleRunningLease(row.id);
      unresolvedRunning += 1;
      continue;
    }

    if (helperOperation.success && helperOperation.found && helperOperation.status === 'unknown') {
      await markJobInterrupted(
        row.id,
        row.requestedBy,
        type,
        helperOperation.error
          ? `${STALE_INTERRUPT_ERROR} (${helperOperation.error})`
          : `${STALE_INTERRUPT_ERROR} (helper reported unknown outcome)`
      );
      handled += 1;
      continue;
    }

    await markJobInterrupted(
      row.id,
      row.requestedBy,
      type,
      helperOperation.success
        ? STALE_INTERRUPT_ERROR
        : `${STALE_INTERRUPT_ERROR} (helper operation status unavailable)`
    );
    handled += 1;
  }

  return { handled, unresolvedRunning };
}

async function claimNextQueuedJob(): Promise<typeof backupJobs.$inferSelect | null> {
  const leaseSeconds = Math.floor(WORKER_LEASE_MS / 1000);
  const claimResult = await getPool().query<{
    id: string;
    type: string;
    status: string;
    request_payload: Record<string, unknown>;
    result_payload: Record<string, unknown> | null;
    error: string | null;
    requested_by: string | null;
    worker_id: string | null;
    lease_expires_at: Date | null;
    last_heartbeat_at: Date | null;
    created_at: Date;
    started_at: Date | null;
    finished_at: Date | null;
    updated_at: Date;
  }>(
    `
      UPDATE backup_jobs
      SET
        status = 'running',
        started_at = NOW(),
        updated_at = NOW(),
        worker_id = $1,
        lease_expires_at = NOW() + make_interval(secs => $2),
        last_heartbeat_at = NOW()
      WHERE id = (
        SELECT id
        FROM backup_jobs
        WHERE status = 'queued'
        ORDER BY created_at ASC
        LIMIT 1
      )
      AND status = 'queued'
      RETURNING *
    `,
    [workerId, leaseSeconds]
  );

  const row = claimResult.rows[0];
  if (!row) {
    return null;
  }

  return {
    id: row.id,
    type: row.type,
    status: row.status,
    requestPayload: row.request_payload,
    resultPayload: row.result_payload,
    error: row.error,
    requestedBy: row.requested_by,
    workerId: row.worker_id,
    leaseExpiresAt: row.lease_expires_at,
    lastHeartbeatAt: row.last_heartbeat_at,
    createdAt: row.created_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    updatedAt: row.updated_at,
  };
}

async function heartbeatRunningJob(jobId: string): Promise<void> {
  const db = getDb();
  const leaseSeconds = Math.floor(WORKER_LEASE_MS / 1000);

  await db
    .update(backupJobs)
    .set({
      leaseExpiresAt: sql`NOW() + make_interval(secs => ${leaseSeconds})`,
      lastHeartbeatAt: new Date(),
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(backupJobs.id, jobId),
        eq(backupJobs.status, 'running'),
        eq(backupJobs.workerId, workerId)
      )
    );
}

async function finalizeJobSuccess(
  jobId: string,
  resultPayload: Record<string, unknown>,
  requestedBy: string | null,
  auditAction: string,
  auditTarget: string | undefined,
  auditDetails: Record<string, unknown>
): Promise<void> {
  const db = getDb();
  await db
    .update(backupJobs)
    .set({
      status: 'succeeded',
      resultPayload,
      error: null,
      finishedAt: new Date(),
      leaseExpiresAt: null,
      lastHeartbeatAt: null,
      workerId: null,
      updatedAt: new Date(),
    })
    .where(eq(backupJobs.id, jobId));

  if (requestedBy) {
    await logAudit({
      userId: requestedBy,
      action: auditAction,
      target: auditTarget,
      success: true,
      details: { ...auditDetails, jobId },
    }).catch(() => undefined);
  }
}

async function finalizeJobFailure(
  jobId: string,
  error: string,
  requestedBy: string | null,
  auditAction: string,
  auditTarget: string | undefined,
  auditDetails: Record<string, unknown>
): Promise<void> {
  const db = getDb();
  await db
    .update(backupJobs)
    .set({
      status: 'failed',
      error,
      finishedAt: new Date(),
      leaseExpiresAt: null,
      lastHeartbeatAt: null,
      workerId: null,
      updatedAt: new Date(),
    })
    .where(eq(backupJobs.id, jobId));

  if (requestedBy) {
    await logAudit({
      userId: requestedBy,
      action: auditAction,
      target: auditTarget,
      success: false,
      details: { ...auditDetails, jobId, error },
    }).catch(() => undefined);
  }
}

async function executeClaimedJob(job: typeof backupJobs.$inferSelect): Promise<void> {
  const heartbeat = setInterval(() => {
    void heartbeatRunningJob(job.id).catch(() => undefined);
  }, WORKER_HEARTBEAT_MS);

  try {
    if (job.type === 'create') {
      const payload = (job.requestPayload ?? {}) as CreateBackupJobPayload;
      const result = await backupService.createBackup(payload.label, job.requestedBy ?? null, job.id);

      if (!result.success || !result.backup) {
        await finalizeJobFailure(
          job.id,
          result.error ?? 'Backup creation failed',
          job.requestedBy,
          'backup.create',
          undefined,
          { label: payload.label ?? null }
        );
        return;
      }

      await finalizeJobSuccess(
        job.id,
        { backup: result.backup },
        job.requestedBy,
        'backup.create',
        result.backup.filename,
        { label: payload.label ?? null, sha256: result.backup.sha256 }
      );
      return;
    }

    const payload = (job.requestPayload ?? {}) as RestoreBackupJobPayload;
    const backupId = payload.backupId;
    if (!backupId || typeof backupId !== 'string') {
      await finalizeJobFailure(
        job.id,
        'Invalid restore request payload',
        job.requestedBy,
        'backup.restore',
        undefined,
        {}
      );
      return;
    }

    const result = await backupService.restoreBackup(backupId, job.id);
    if (!result.success) {
      await finalizeJobFailure(
        job.id,
        result.error ?? 'Backup restore failed',
        job.requestedBy,
        'backup.restore',
        backupId,
        { safetyBackup: result.safetyBackup ?? null }
      );
      return;
    }

    await finalizeJobSuccess(
      job.id,
      {
        message: 'Backup restored successfully',
        safetyBackup: result.safetyBackup ?? null,
      },
      job.requestedBy,
      'backup.restore',
      backupId,
      { safetyBackup: result.safetyBackup ?? null }
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Backup job failed';
    await finalizeJobFailure(
      job.id,
      message,
      job.requestedBy,
      `backup.${job.type}`,
      job.id,
      {}
    );
  } finally {
    clearInterval(heartbeat);
  }
}

async function runWorkerCycle(): Promise<void> {
  if (workerCycleInFlight) {
    return;
  }

  workerCycleInFlight = true;
  let lockClient: PoolClient | null = null;
  let lockAcquired = false;
  try {
    lockClient = await getPool().connect();
    const lockResult = await lockClient.query<{ locked: boolean }>(
      'SELECT pg_try_advisory_lock($1) AS locked',
      [BACKUP_JOB_EXECUTION_LOCK_KEY]
    );
    lockAcquired = lockResult.rows[0]?.locked === true;
    if (!lockAcquired) {
      return;
    }

    const staleResult = await reconcileStaleRunningJobs();
    if (staleResult.unresolvedRunning > 0) {
      return;
    }
    const job = await claimNextQueuedJob();
    if (!job) return;
    await executeClaimedJob(job);
  } finally {
    if (lockClient && lockAcquired) {
      await lockClient
        .query('SELECT pg_advisory_unlock($1)', [BACKUP_JOB_EXECUTION_LOCK_KEY])
        .catch(() => undefined);
    }
    lockClient?.release();
    workerCycleInFlight = false;
  }
}

export async function runBackupJobWorkerCycleForTests(): Promise<void> {
  await runWorkerCycle();
}

export function startBackupJobWorker(): void {
  if (workerTimer) {
    return;
  }

  workerTimer = setInterval(() => {
    void runWorkerCycle().catch((err) => {
      console.error('[BackupJobWorker] cycle failed:', err);
    });
  }, WORKER_POLL_INTERVAL_MS);

  void runWorkerCycle().catch((err) => {
    console.error('[BackupJobWorker] startup cycle failed:', err);
  });
}

export function stopBackupJobWorker(): void {
  if (!workerTimer) {
    return;
  }

  clearInterval(workerTimer);
  workerTimer = null;
}
