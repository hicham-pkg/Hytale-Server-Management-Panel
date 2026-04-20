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

const auditServiceMock = vi.hoisted(() => ({
  logAudit: vi.fn(),
}));

vi.mock('../../packages/api/src/services/backup.service', () => backupServiceMock);
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
    auditServiceMock.logAudit.mockReset();
    auditServiceMock.logAudit.mockResolvedValue(undefined);
  });

  it('returns degraded helper state when backup create hits helper transport failure', async () => {
    const { HelperUnavailableError } = await import('../../packages/api/src/services/helper-client');
    backupServiceMock.createBackup.mockRejectedValue(
      new HelperUnavailableError('backup.create', 'Helper request timed out for backup.create')
    );

    const { backupRoutes } = await import('../../packages/api/src/routes/backup.routes');

    const app = Fastify({ trustProxy: true });
    await app.register(fastifyCookie);
    await app.register(backupRoutes);

    const response = await app.inject({
      method: 'POST',
      url: '/api/backups/create',
      payload: {},
    });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({
      success: false,
      error: 'Helper service unavailable',
      data: {
        degraded: true,
        dependency: 'helper',
      },
    });

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
