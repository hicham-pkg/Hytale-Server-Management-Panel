import { createRequire } from 'node:module';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const apiRequire = createRequire(new URL('../../packages/api/package.json', import.meta.url));
const Fastify = apiRequire('fastify') as typeof import('fastify').default;
const fastifyCookie = apiRequire('@fastify/cookie') as typeof import('@fastify/cookie').default;

const backupServiceMock = vi.hoisted(() => ({
  listBackups: vi.fn(),
  createBackup: vi.fn(),
  restoreBackup: vi.fn(),
  deleteBackup: vi.fn(),
}));

const backupJobServiceMock = vi.hoisted(() => ({
  enqueueCreateBackupJob: vi.fn(),
  enqueueRestoreBackupJob: vi.fn(),
  getBackupJob: vi.fn(),
  listBackupJobs: vi.fn(),
}));

const auditServiceMock = vi.hoisted(() => ({
  logAudit: vi.fn(),
}));

vi.mock('../../packages/api/src/services/backup.service', () => backupServiceMock);
vi.mock('../../packages/api/src/services/backup-job.service', () => backupJobServiceMock);
vi.mock('../../packages/api/src/services/audit.service', () => auditServiceMock);
vi.mock('../../packages/api/src/middleware/require-auth', () => ({
  requireAuth: async (request: { currentUser?: { id: string; role: string } }) => {
    request.currentUser = { id: '550e8400-e29b-41d4-a716-446655440001', role: 'admin' };
  },
}));
vi.mock('../../packages/api/src/middleware/require-role', () => ({
  requireRole: () => async () => {},
}));

describe('backup routes degraded helper handling', () => {
  beforeEach(() => {
    backupServiceMock.listBackups.mockReset();
    backupServiceMock.createBackup.mockReset();
    backupServiceMock.restoreBackup.mockReset();
    backupServiceMock.deleteBackup.mockReset();
    backupJobServiceMock.enqueueCreateBackupJob.mockReset();
    backupJobServiceMock.enqueueRestoreBackupJob.mockReset();
    backupJobServiceMock.getBackupJob.mockReset();
    backupJobServiceMock.listBackupJobs.mockReset();
    auditServiceMock.logAudit.mockReset();
    auditServiceMock.logAudit.mockResolvedValue(undefined);
  });

  it('enqueues backup create requests and returns 202 Accepted', async () => {
    backupJobServiceMock.enqueueCreateBackupJob.mockResolvedValue({
      id: '550e8400-e29b-41d4-a716-4466554400aa',
      type: 'create',
      status: 'queued',
      requestPayload: {},
      resultPayload: null,
      error: null,
      requestedBy: '550e8400-e29b-41d4-a716-446655440001',
      workerId: null,
      leaseExpiresAt: null,
      lastHeartbeatAt: null,
      createdAt: '2026-04-20T10:00:00.000Z',
      startedAt: null,
      finishedAt: null,
      updatedAt: '2026-04-20T10:00:00.000Z',
    });

    const { backupRoutes } = await import('../../packages/api/src/routes/backup.routes');

    const app = Fastify({ trustProxy: true });
    await app.register(fastifyCookie);
    await app.register(backupRoutes);

    const response = await app.inject({
      method: 'POST',
      url: '/api/backups/create',
      payload: {},
    });

    expect(response.statusCode).toBe(202);
    expect(response.json()).toEqual({
      success: true,
      data: {
        job: expect.objectContaining({
          id: '550e8400-e29b-41d4-a716-4466554400aa',
          type: 'create',
          status: 'queued',
        }),
      },
    });
    expect(backupJobServiceMock.enqueueCreateBackupJob).toHaveBeenCalledWith(
      undefined,
      '550e8400-e29b-41d4-a716-446655440001'
    );

    await app.close();
  });

  it('enqueues backup restore requests and returns 202 Accepted', async () => {
    backupJobServiceMock.enqueueRestoreBackupJob.mockResolvedValue({
      id: '550e8400-e29b-41d4-a716-4466554400bb',
      type: 'restore',
      status: 'queued',
      requestPayload: { backupId: '550e8400-e29b-41d4-a716-446655440111' },
      resultPayload: null,
      error: null,
      requestedBy: '550e8400-e29b-41d4-a716-446655440001',
      workerId: null,
      leaseExpiresAt: null,
      lastHeartbeatAt: null,
      createdAt: '2026-04-20T10:00:00.000Z',
      startedAt: null,
      finishedAt: null,
      updatedAt: '2026-04-20T10:00:00.000Z',
    });

    const { backupRoutes } = await import('../../packages/api/src/routes/backup.routes');

    const app = Fastify({ trustProxy: true });
    await app.register(fastifyCookie);
    await app.register(backupRoutes);

    const response = await app.inject({
      method: 'POST',
      url: '/api/backups/550e8400-e29b-41d4-a716-446655440111/restore',
      payload: {},
    });

    expect(response.statusCode).toBe(202);
    expect(response.json()).toEqual({
      success: true,
      data: {
        job: expect.objectContaining({
          id: '550e8400-e29b-41d4-a716-4466554400bb',
          type: 'restore',
          status: 'queued',
        }),
      },
    });
    expect(backupJobServiceMock.enqueueRestoreBackupJob).toHaveBeenCalledWith(
      '550e8400-e29b-41d4-a716-446655440111',
      '550e8400-e29b-41d4-a716-446655440001'
    );

    await app.close();
  });

  it('propagates helperOffline metadata in backup list responses', async () => {
    backupServiceMock.listBackups.mockResolvedValue({
      helperOffline: true,
      backups: [],
    });

    const { backupRoutes } = await import('../../packages/api/src/routes/backup.routes');

    const app = Fastify({ trustProxy: true });
    await app.register(fastifyCookie);
    await app.register(backupRoutes);

    const response = await app.inject({
      method: 'GET',
      url: '/api/backups',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      success: true,
      data: {
        backups: [],
        helperOffline: true,
      },
    });

    await app.close();
  });
});
