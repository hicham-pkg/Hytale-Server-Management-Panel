import { beforeEach, describe, expect, it, vi } from 'vitest';

interface BackupJobRow {
  id: string;
  type: 'create' | 'restore';
  status: 'queued' | 'running' | 'succeeded' | 'failed' | 'interrupted';
  requestPayload: Record<string, unknown>;
  resultPayload: Record<string, unknown> | null;
  error: string | null;
  requestedBy: string | null;
  workerId: string | null;
  leaseExpiresAt: Date | null;
  lastHeartbeatAt: Date | null;
  createdAt: Date;
  startedAt: Date | null;
  finishedAt: Date | null;
  updatedAt: Date;
}

const backupServiceMock = vi.hoisted(() => ({
  createBackup: vi.fn(),
  restoreBackup: vi.fn(),
  getBackupOperationStatus: vi.fn(),
}));

const auditServiceMock = vi.hoisted(() => ({
  logAudit: vi.fn(),
}));

const state = vi.hoisted(() => ({
  jobs: [] as BackupJobRow[],
  idCounter: 0,
  advisoryLockHeld: false,
  forceLockUnavailable: false,
  lockAcquireCalls: 0,
  lockReleaseCalls: 0,
  clientReleaseCalls: 0,
}));

function nextJobId(): string {
  state.idCounter += 1;
  return `00000000-0000-4000-8000-${String(state.idCounter).padStart(12, '0')}`;
}

function toSnakeCaseRow(row: BackupJobRow) {
  return {
    id: row.id,
    type: row.type,
    status: row.status,
    request_payload: row.requestPayload,
    result_payload: row.resultPayload,
    error: row.error,
    requested_by: row.requestedBy,
    worker_id: row.workerId,
    lease_expires_at: row.leaseExpiresAt,
    last_heartbeat_at: row.lastHeartbeatAt,
    created_at: row.createdAt,
    started_at: row.startedAt,
    finished_at: row.finishedAt,
    updated_at: row.updatedAt,
  };
}

function flattenSqlExpression(value: unknown): string {
  if (value === null || value === undefined) {
    return '';
  }

  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }

  if (Array.isArray(value)) {
    return value.map((entry) => flattenSqlExpression(entry)).join('');
  }

  if (typeof value === 'object') {
    const record = value as { value?: unknown; queryChunks?: unknown };
    if (record.value !== undefined) {
      return flattenSqlExpression(record.value);
    }
    if (record.queryChunks !== undefined) {
      return flattenSqlExpression(record.queryChunks);
    }
  }

  return '';
}

function evaluateSqlCondition(row: BackupJobRow, text: string): boolean {
  if (text.includes('leaseExpiresAt IS NOT NULL')) {
    return row.leaseExpiresAt !== null;
  }

  if (text.includes('leaseExpiresAt < NOW()')) {
    return row.leaseExpiresAt !== null && row.leaseExpiresAt.getTime() < Date.now();
  }

  return true;
}

function evaluateCondition(row: BackupJobRow, condition: any): boolean {
  if (!condition) {
    return true;
  }

  if (condition.kind === 'eq') {
    return (row as Record<string, unknown>)[condition.column] === condition.value;
  }

  if (condition.kind === 'inArray') {
    return condition.values.includes((row as Record<string, unknown>)[condition.column]);
  }

  if (condition.kind === 'and') {
    return condition.conditions.every((sub: any) => evaluateCondition(row, sub));
  }

  if (condition.kind === 'sql') {
    return evaluateSqlCondition(row, condition.text);
  }

  if (condition && typeof condition === 'object' && 'queryChunks' in condition) {
    const text = flattenSqlExpression(condition).replace(/\s+/g, ' ').trim();
    let matches = true;

    if (text.includes('status = running')) {
      matches = matches && row.status === 'running';
    }

    if (text.includes('status = queued')) {
      matches = matches && row.status === 'queued';
    }

    if (text.includes('leaseExpiresAt IS NOT NULL')) {
      matches = matches && row.leaseExpiresAt !== null;
    }

    if (text.includes('leaseExpiresAt < NOW()')) {
      matches = matches && row.leaseExpiresAt !== null && row.leaseExpiresAt.getTime() < Date.now();
    }

    const idMatch = text.match(/id = ([0-9a-fA-F-]+)/);
    if (idMatch) {
      matches = matches && row.id === idMatch[1];
    }

    const workerIdMatch = text.match(/workerId = ([^ )]+)/);
    if (workerIdMatch) {
      matches = matches && row.workerId === workerIdMatch[1];
    }

    return matches;
  }

  return true;
}

function applyPatch(row: BackupJobRow, patch: Record<string, unknown>) {
  for (const [key, value] of Object.entries(patch)) {
    if (value && typeof value === 'object') {
      const sqlText = flattenSqlExpression(value);
      if (sqlText.includes('NOW() + make_interval(secs =>')) {
        const secondsMatch = sqlText.match(/NOW\(\) \+ make_interval\(secs => (\d+)\)/);
        const seconds = secondsMatch ? Number(secondsMatch[1]) : 90;
        (row as Record<string, unknown>)[key] = new Date(Date.now() + seconds * 1000);
        continue;
      }
    }

    (row as Record<string, unknown>)[key] = value;
  }
}

function projectRow(row: BackupJobRow, fields: Record<string, string> | undefined) {
  if (!fields) {
    return row;
  }

  const projected: Record<string, unknown> = {};
  for (const [key, column] of Object.entries(fields)) {
    projected[key] = (row as Record<string, unknown>)[column];
  }

  return projected;
}

vi.mock('../../packages/api/src/services/backup.service', () => backupServiceMock);
vi.mock('../../packages/api/src/services/audit.service', () => auditServiceMock);

vi.mock('../../packages/api/src/db', () => {
  const backupJobs = {
    id: 'id',
    type: 'type',
    status: 'status',
    requestPayload: 'requestPayload',
    resultPayload: 'resultPayload',
    error: 'error',
    requestedBy: 'requestedBy',
    workerId: 'workerId',
    leaseExpiresAt: 'leaseExpiresAt',
    lastHeartbeatAt: 'lastHeartbeatAt',
    createdAt: 'createdAt',
    startedAt: 'startedAt',
    finishedAt: 'finishedAt',
    updatedAt: 'updatedAt',
  };

  const db = {
    insert: () => ({
      values: (values: Record<string, unknown>) => ({
        returning: async () => {
          const now = new Date();
          const row: BackupJobRow = {
            id: nextJobId(),
            type: values.type as 'create' | 'restore',
            status: values.status as BackupJobRow['status'],
            requestPayload: (values.requestPayload ?? {}) as Record<string, unknown>,
            resultPayload: null,
            error: null,
            requestedBy: (values.requestedBy as string) ?? null,
            workerId: null,
            leaseExpiresAt: null,
            lastHeartbeatAt: null,
            createdAt: now,
            startedAt: null,
            finishedAt: null,
            updatedAt: (values.updatedAt as Date) ?? now,
          };
          state.jobs.push(row);
          return [row];
        },
      }),
    }),

    select: (fields?: Record<string, string>) => ({
      from: () => {
        let condition: any;
        let sortByCreatedAtDesc = false;

        const execute = () => {
          let rows = state.jobs.filter((row) => evaluateCondition(row, condition));
          if (sortByCreatedAtDesc) {
            rows = [...rows].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
          }
          return rows.map((row) => projectRow(row, fields));
        };

        return {
          where: (nextCondition: any) => {
            condition = nextCondition;
            return {
              orderBy: () => {
                sortByCreatedAtDesc = true;
                return {
                  limit: async (limit: number) => execute().slice(0, limit),
                };
              },
              limit: async (limit: number) => execute().slice(0, limit),
              then: (resolve: (value: unknown[]) => unknown) => Promise.resolve(resolve(execute())),
            };
          },
          orderBy: () => {
            sortByCreatedAtDesc = true;
            return {
              limit: async (limit: number) => execute().slice(0, limit),
            };
          },
        };
      },
    }),

    update: () => ({
      set: (patch: Record<string, unknown>) => ({
        where: async (condition: any) => {
          for (const row of state.jobs) {
            if (evaluateCondition(row, condition)) {
              applyPatch(row, patch);
            }
          }
        },
      }),
    }),
  };

  const pool = {
    connect: async () => ({
      query: async (queryText: string) => {
        if (queryText.includes('pg_try_advisory_lock')) {
          state.lockAcquireCalls += 1;
          if (state.forceLockUnavailable || state.advisoryLockHeld) {
            return { rows: [{ locked: false }] };
          }

          state.advisoryLockHeld = true;
          return { rows: [{ locked: true }] };
        }

        if (queryText.includes('pg_advisory_unlock')) {
          if (state.advisoryLockHeld) {
            state.advisoryLockHeld = false;
            state.lockReleaseCalls += 1;
            return { rows: [{ pg_advisory_unlock: true }] };
          }

          return { rows: [{ pg_advisory_unlock: false }] };
        }

        return { rows: [] };
      },
      release: () => {
        state.clientReleaseCalls += 1;
      },
    }),
    query: async (queryText: string, params: unknown[]) => {
      if (!queryText.includes('UPDATE backup_jobs')) {
        return { rows: [] };
      }

      const claimed = [...state.jobs]
        .filter((row) => row.status === 'queued')
        .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())[0];

      if (!claimed) {
        return { rows: [] };
      }

      const now = new Date();
      const leaseSeconds = Number(params[1]);
      claimed.status = 'running';
      claimed.startedAt = now;
      claimed.updatedAt = now;
      claimed.workerId = String(params[0]);
      claimed.lastHeartbeatAt = now;
      claimed.leaseExpiresAt = new Date(now.getTime() + leaseSeconds * 1000);

      return { rows: [toSnakeCaseRow(claimed)] };
    },
  };

  return {
    getDb: () => db,
    getPool: () => pool,
    schema: { backupJobs },
  };
});

describe('backup job worker', () => {
  beforeEach(() => {
    state.jobs = [];
    state.idCounter = 0;
    state.advisoryLockHeld = false;
    state.forceLockUnavailable = false;
    state.lockAcquireCalls = 0;
    state.lockReleaseCalls = 0;
    state.clientReleaseCalls = 0;
    backupServiceMock.createBackup.mockReset();
    backupServiceMock.restoreBackup.mockReset();
    backupServiceMock.getBackupOperationStatus.mockReset();
    backupServiceMock.getBackupOperationStatus.mockResolvedValue({
      success: true,
      found: false,
    });
    auditServiceMock.logAudit.mockReset();
    auditServiceMock.logAudit.mockResolvedValue(undefined);
  });

  it('enqueues and executes a create job to succeeded state', async () => {
    backupServiceMock.createBackup.mockResolvedValue({
      success: true,
      backup: {
        id: '550e8400-e29b-41d4-a716-4466554400aa',
        filename: '2026-04-20T10-00-00-000Z_world.tar.gz',
        label: 'nightly',
        sizeBytes: 1234,
        sha256: 'abc123',
        createdBy: '550e8400-e29b-41d4-a716-446655440001',
        createdAt: '2026-04-20T10:00:00.000Z',
      },
    });

    const backupJobService = await import('../../packages/api/src/services/backup-job.service');

    const queued = await backupJobService.enqueueCreateBackupJob('nightly', '550e8400-e29b-41d4-a716-446655440001');
    expect(queued.status).toBe('queued');

    await backupJobService.runBackupJobWorkerCycleForTests();

    const completed = await backupJobService.getBackupJob(queued.id);
    expect(completed).not.toBeNull();
    expect(completed?.status).toBe('succeeded');
    expect((completed?.resultPayload as { backup?: { filename?: string } } | null)?.backup?.filename).toBe(
      '2026-04-20T10-00-00-000Z_world.tar.gz'
    );
    expect(backupServiceMock.createBackup).toHaveBeenCalledWith(
      'nightly',
      '550e8400-e29b-41d4-a716-446655440001',
      queued.id
    );
    expect(state.lockAcquireCalls).toBe(1);
    expect(state.lockReleaseCalls).toBe(1);
    expect(state.clientReleaseCalls).toBe(1);
    expect(state.advisoryLockHeld).toBe(false);
  });

  it('marks stale running jobs as interrupted when lease is expired', async () => {
    state.jobs.push({
      id: '00000000-0000-4000-8000-000000000001',
      type: 'create',
      status: 'running',
      requestPayload: { label: 'nightly' },
      resultPayload: null,
      error: null,
      requestedBy: '550e8400-e29b-41d4-a716-446655440001',
      workerId: 'backup-worker-old',
      leaseExpiresAt: new Date(Date.now() - 60_000),
      lastHeartbeatAt: new Date(Date.now() - 70_000),
      createdAt: new Date(Date.now() - 120_000),
      startedAt: new Date(Date.now() - 110_000),
      finishedAt: null,
      updatedAt: new Date(Date.now() - 70_000),
    });

    const backupJobService = await import('../../packages/api/src/services/backup-job.service');

    await backupJobService.runBackupJobWorkerCycleForTests();

    const stale = await backupJobService.getBackupJob('00000000-0000-4000-8000-000000000001');
    expect(stale?.status).toBe('interrupted');
    expect(stale?.error).toBe('Backup job interrupted by API restart or worker failure');
    expect(stale?.finishedAt).toBeTruthy();
    expect(auditServiceMock.logAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'backup.create.interrupted',
        success: false,
      })
    );
  });

  it('reconciles stale running jobs to succeeded when helper operation state is succeeded', async () => {
    state.jobs.push({
      id: '00000000-0000-4000-8000-000000000010',
      type: 'restore',
      status: 'running',
      requestPayload: { backupId: '550e8400-e29b-41d4-a716-446655440099' },
      resultPayload: null,
      error: null,
      requestedBy: '550e8400-e29b-41d4-a716-446655440001',
      workerId: 'backup-worker-old',
      leaseExpiresAt: new Date(Date.now() - 60_000),
      lastHeartbeatAt: new Date(Date.now() - 70_000),
      createdAt: new Date(Date.now() - 120_000),
      startedAt: new Date(Date.now() - 110_000),
      finishedAt: null,
      updatedAt: new Date(Date.now() - 70_000),
    });

    backupServiceMock.getBackupOperationStatus.mockResolvedValue({
      success: true,
      found: true,
      status: 'succeeded',
      resultPayload: {
        message: 'Backup restored successfully',
        safetyBackup: 'safety-pre-restore.tar.gz',
      },
    });

    const backupJobService = await import('../../packages/api/src/services/backup-job.service');
    await backupJobService.runBackupJobWorkerCycleForTests();

    const reconciled = await backupJobService.getBackupJob('00000000-0000-4000-8000-000000000010');
    expect(reconciled?.status).toBe('succeeded');
    expect((reconciled?.resultPayload as { safetyBackup?: string } | null)?.safetyBackup).toBe('safety-pre-restore.tar.gz');
  });

  it('reconciles stale running jobs to failed when helper operation state is failed', async () => {
    state.jobs.push({
      id: '00000000-0000-4000-8000-000000000011',
      type: 'create',
      status: 'running',
      requestPayload: { label: 'nightly' },
      resultPayload: null,
      error: null,
      requestedBy: '550e8400-e29b-41d4-a716-446655440001',
      workerId: 'backup-worker-old',
      leaseExpiresAt: new Date(Date.now() - 60_000),
      lastHeartbeatAt: new Date(Date.now() - 70_000),
      createdAt: new Date(Date.now() - 120_000),
      startedAt: new Date(Date.now() - 110_000),
      finishedAt: null,
      updatedAt: new Date(Date.now() - 70_000),
    });

    backupServiceMock.getBackupOperationStatus.mockResolvedValue({
      success: true,
      found: true,
      status: 'failed',
      error: 'Backup archive creation failed',
    });

    const backupJobService = await import('../../packages/api/src/services/backup-job.service');
    await backupJobService.runBackupJobWorkerCycleForTests();

    const reconciled = await backupJobService.getBackupJob('00000000-0000-4000-8000-000000000011');
    expect(reconciled?.status).toBe('failed');
    expect(reconciled?.error).toBe('Backup archive creation failed');
  });

  it('keeps stale jobs running (and blocks new claims) when helper reports running', async () => {
    state.jobs.push({
      id: '00000000-0000-4000-8000-000000000020',
      type: 'restore',
      status: 'running',
      requestPayload: { backupId: '550e8400-e29b-41d4-a716-446655440099' },
      resultPayload: null,
      error: null,
      requestedBy: '550e8400-e29b-41d4-a716-446655440001',
      workerId: 'backup-worker-old',
      leaseExpiresAt: new Date(Date.now() - 60_000),
      lastHeartbeatAt: new Date(Date.now() - 70_000),
      createdAt: new Date(Date.now() - 120_000),
      startedAt: new Date(Date.now() - 110_000),
      finishedAt: null,
      updatedAt: new Date(Date.now() - 70_000),
    });
    state.jobs.push({
      id: '00000000-0000-4000-8000-000000000021',
      type: 'create',
      status: 'queued',
      requestPayload: { label: 'nightly' },
      resultPayload: null,
      error: null,
      requestedBy: '550e8400-e29b-41d4-a716-446655440001',
      workerId: null,
      leaseExpiresAt: null,
      lastHeartbeatAt: null,
      createdAt: new Date(Date.now() - 60_000),
      startedAt: null,
      finishedAt: null,
      updatedAt: new Date(Date.now() - 60_000),
    });

    backupServiceMock.getBackupOperationStatus.mockResolvedValue({
      success: true,
      found: true,
      status: 'running',
    });

    const backupJobService = await import('../../packages/api/src/services/backup-job.service');
    await backupJobService.runBackupJobWorkerCycleForTests();

    const running = await backupJobService.getBackupJob('00000000-0000-4000-8000-000000000020');
    const queued = await backupJobService.getBackupJob('00000000-0000-4000-8000-000000000021');
    expect(running?.status).toBe('running');
    expect(running?.leaseExpiresAt).not.toBeNull();
    expect(queued?.status).toBe('queued');
    expect(backupServiceMock.createBackup).not.toHaveBeenCalled();
  });

  it('maps helper unknown stale outcomes to interrupted conservatively', async () => {
    state.jobs.push({
      id: '00000000-0000-4000-8000-000000000022',
      type: 'restore',
      status: 'running',
      requestPayload: { backupId: '550e8400-e29b-41d4-a716-446655440099' },
      resultPayload: null,
      error: null,
      requestedBy: '550e8400-e29b-41d4-a716-446655440001',
      workerId: 'backup-worker-old',
      leaseExpiresAt: new Date(Date.now() - 60_000),
      lastHeartbeatAt: new Date(Date.now() - 70_000),
      createdAt: new Date(Date.now() - 120_000),
      startedAt: new Date(Date.now() - 110_000),
      finishedAt: null,
      updatedAt: new Date(Date.now() - 70_000),
    });

    backupServiceMock.getBackupOperationStatus.mockResolvedValue({
      success: true,
      found: true,
      status: 'unknown',
      error: 'Restore outcome unknown after helper restart',
    });

    const backupJobService = await import('../../packages/api/src/services/backup-job.service');
    await backupJobService.runBackupJobWorkerCycleForTests();

    const reconciled = await backupJobService.getBackupJob('00000000-0000-4000-8000-000000000022');
    expect(reconciled?.status).toBe('interrupted');
    expect(reconciled?.error).toContain('Restore outcome unknown after helper restart');
  });

  it('skips execution safely when global advisory lock is unavailable', async () => {
    state.forceLockUnavailable = true;

    backupServiceMock.createBackup.mockResolvedValue({
      success: true,
      backup: {
        id: '550e8400-e29b-41d4-a716-4466554400aa',
        filename: '2026-04-20T10-00-00-000Z_world.tar.gz',
        label: null,
        sizeBytes: 1234,
        sha256: 'abc123',
        createdBy: '550e8400-e29b-41d4-a716-446655440001',
        createdAt: '2026-04-20T10:00:00.000Z',
      },
    });

    const backupJobService = await import('../../packages/api/src/services/backup-job.service');
    const queued = await backupJobService.enqueueCreateBackupJob(undefined, '550e8400-e29b-41d4-a716-446655440001');

    await backupJobService.runBackupJobWorkerCycleForTests();

    const job = await backupJobService.getBackupJob(queued.id);
    expect(job?.status).toBe('queued');
    expect(backupServiceMock.createBackup).not.toHaveBeenCalled();
    expect(state.lockAcquireCalls).toBe(1);
    expect(state.lockReleaseCalls).toBe(0);
    expect(state.clientReleaseCalls).toBe(1);
  });

  it('releases advisory lock even when job execution fails', async () => {
    backupServiceMock.createBackup.mockRejectedValue(new Error('simulated backup crash'));

    const backupJobService = await import('../../packages/api/src/services/backup-job.service');
    const queued = await backupJobService.enqueueCreateBackupJob(undefined, '550e8400-e29b-41d4-a716-446655440001');

    await backupJobService.runBackupJobWorkerCycleForTests();

    const job = await backupJobService.getBackupJob(queued.id);
    expect(job?.status).toBe('failed');
    expect(job?.error).toBe('simulated backup crash');
    expect(state.lockAcquireCalls).toBe(1);
    expect(state.lockReleaseCalls).toBe(1);
    expect(state.clientReleaseCalls).toBe(1);
    expect(state.advisoryLockHeld).toBe(false);
  });

  it('prevents a second worker module from executing another job while lock is held', async () => {
    let resolveFirstJob: (() => void) | null = null;
    const firstJobPromise = new Promise<void>((resolve) => {
      resolveFirstJob = resolve;
    });

    backupServiceMock.createBackup.mockResolvedValue({
      success: true,
      backup: {
        id: '550e8400-e29b-41d4-a716-4466554400aa',
        filename: '2026-04-20T10-00-00-000Z_world.tar.gz',
        label: null,
        sizeBytes: 1234,
        sha256: 'abc123',
        createdBy: '550e8400-e29b-41d4-a716-446655440001',
        createdAt: '2026-04-20T10:00:00.000Z',
      },
    });
    backupServiceMock.createBackup
      .mockImplementationOnce(async () => {
        await firstJobPromise;
        return {
          success: true,
          backup: {
            id: '550e8400-e29b-41d4-a716-4466554400aa',
            filename: '2026-04-20T10-00-00-000Z_world.tar.gz',
            label: null,
            sizeBytes: 1234,
            sha256: 'abc123',
            createdBy: '550e8400-e29b-41d4-a716-446655440001',
            createdAt: '2026-04-20T10:00:00.000Z',
          },
        };
      })
      .mockResolvedValue({
        success: true,
        backup: {
          id: '550e8400-e29b-41d4-a716-4466554400ab',
          filename: '2026-04-20T10-05-00-000Z_world.tar.gz',
          label: 'second',
          sizeBytes: 1234,
          sha256: 'def456',
          createdBy: '550e8400-e29b-41d4-a716-446655440001',
          createdAt: '2026-04-20T10:05:00.000Z',
        },
      });

    const backupJobServiceOne = await import('../../packages/api/src/services/backup-job.service');
    const first = await backupJobServiceOne.enqueueCreateBackupJob(undefined, '550e8400-e29b-41d4-a716-446655440001');
    const second = await backupJobServiceOne.enqueueCreateBackupJob('second', '550e8400-e29b-41d4-a716-446655440001');

    const firstWorkerCycle = backupJobServiceOne.runBackupJobWorkerCycleForTests();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(state.advisoryLockHeld).toBe(true);

    vi.resetModules();
    const backupJobServiceTwo = await import('../../packages/api/src/services/backup-job.service');
    await backupJobServiceTwo.runBackupJobWorkerCycleForTests();

    const duringFirst = await backupJobServiceTwo.getBackupJob(second.id);
    expect(duringFirst?.status).toBe('queued');
    expect(backupServiceMock.createBackup).toHaveBeenCalledTimes(1);

    resolveFirstJob?.();
    await firstWorkerCycle;

    await backupJobServiceTwo.runBackupJobWorkerCycleForTests();

    const firstAfter = await backupJobServiceTwo.getBackupJob(first.id);
    const secondAfter = await backupJobServiceTwo.getBackupJob(second.id);
    expect(firstAfter?.status).toBe('succeeded');
    expect(secondAfter?.status).toBe('succeeded');
    expect(state.lockAcquireCalls).toBeGreaterThanOrEqual(3);
    expect(state.lockReleaseCalls).toBe(2);
    expect(state.clientReleaseCalls).toBeGreaterThanOrEqual(3);
  });
});
