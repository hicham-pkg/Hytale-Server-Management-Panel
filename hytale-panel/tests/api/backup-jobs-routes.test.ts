import { createRequire } from 'node:module';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const apiRequire = createRequire(new URL('../../packages/api/package.json', import.meta.url));
const Fastify = apiRequire('fastify') as typeof import('fastify').default;
const fastifyCookie = apiRequire('@fastify/cookie') as typeof import('@fastify/cookie').default;

const backupJobServiceMock = vi.hoisted(() => ({
  getBackupJob: vi.fn(),
  listBackupJobs: vi.fn(),
}));

vi.mock('../../packages/api/src/services/backup-job.service', () => backupJobServiceMock);
vi.mock('../../packages/api/src/middleware/require-auth', () => ({
  requireAuth: async (request: { currentUser?: { id: string; role: string } }) => {
    request.currentUser = { id: '550e8400-e29b-41d4-a716-446655440001', role: 'admin' };
  },
}));
vi.mock('../../packages/api/src/middleware/require-role', () => ({
  requireRole: () => async () => {},
}));

describe('backup job routes', () => {
  beforeEach(() => {
    backupJobServiceMock.getBackupJob.mockReset();
    backupJobServiceMock.listBackupJobs.mockReset();
  });

  it('returns a single backup job by id', async () => {
    backupJobServiceMock.getBackupJob.mockResolvedValue({
      id: '550e8400-e29b-41d4-a716-4466554400aa',
      type: 'create',
      status: 'running',
      requestPayload: {},
      resultPayload: null,
      error: null,
      requestedBy: '550e8400-e29b-41d4-a716-446655440001',
      workerId: 'backup-worker-1',
      leaseExpiresAt: '2026-04-20T10:01:00.000Z',
      lastHeartbeatAt: '2026-04-20T10:00:30.000Z',
      createdAt: '2026-04-20T10:00:00.000Z',
      startedAt: '2026-04-20T10:00:10.000Z',
      finishedAt: null,
      updatedAt: '2026-04-20T10:00:30.000Z',
    });

    const { backupJobRoutes } = await import('../../packages/api/src/routes/backup-jobs.routes');

    const app = Fastify({ trustProxy: true });
    await app.register(fastifyCookie);
    await app.register(backupJobRoutes);

    const response = await app.inject({
      method: 'GET',
      url: '/api/backups/jobs/550e8400-e29b-41d4-a716-4466554400aa',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      success: true,
      data: {
        job: expect.objectContaining({
          id: '550e8400-e29b-41d4-a716-4466554400aa',
          status: 'running',
        }),
      },
    });

    await app.close();
  });

  it('returns 404 when a backup job does not exist', async () => {
    backupJobServiceMock.getBackupJob.mockResolvedValue(null);

    const { backupJobRoutes } = await import('../../packages/api/src/routes/backup-jobs.routes');

    const app = Fastify({ trustProxy: true });
    await app.register(fastifyCookie);
    await app.register(backupJobRoutes);

    const response = await app.inject({
      method: 'GET',
      url: '/api/backups/jobs/550e8400-e29b-41d4-a716-4466554400ff',
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({
      success: false,
      error: 'Backup job not found',
    });

    await app.close();
  });

  it('parses list filters and returns recent jobs', async () => {
    backupJobServiceMock.listBackupJobs.mockResolvedValue([
      {
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
      },
    ]);

    const { backupJobRoutes } = await import('../../packages/api/src/routes/backup-jobs.routes');

    const app = Fastify({ trustProxy: true });
    await app.register(fastifyCookie);
    await app.register(backupJobRoutes);

    const response = await app.inject({
      method: 'GET',
      url: '/api/backups/jobs?status=queued,running&limit=5',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      success: true,
      data: {
        jobs: [
          expect.objectContaining({
            id: '550e8400-e29b-41d4-a716-4466554400aa',
            status: 'queued',
          }),
        ],
      },
    });
    expect(backupJobServiceMock.listBackupJobs).toHaveBeenCalledWith({
      statuses: ['queued', 'running'],
      limit: 5,
    });

    await app.close();
  });
});
