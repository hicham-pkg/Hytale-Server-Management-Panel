import { createRequire } from 'node:module';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const apiRequire = createRequire(new URL('../../packages/api/package.json', import.meta.url));
const Fastify = apiRequire('fastify') as typeof import('fastify').default;
const fastifyCookie = apiRequire('@fastify/cookie') as typeof import('@fastify/cookie').default;

const crashServiceMock = vi.hoisted(() => ({
  queryCrashEvents: vi.fn(),
  getCrashEvent: vi.fn(),
  archiveCrashEvent: vi.fn(),
  archiveHistoricalCrashEvents: vi.fn(),
}));

const auditServiceMock = vi.hoisted(() => ({
  logAudit: vi.fn(),
}));

vi.mock('../../packages/api/src/services/crash.service', () => crashServiceMock);
vi.mock('../../packages/api/src/services/audit.service', () => auditServiceMock);
vi.mock('../../packages/api/src/middleware/require-auth', () => ({
  requireAuth: async (request: { currentUser?: { id: string; role: string } }) => {
    request.currentUser = { id: '11111111-1111-4111-8111-111111111111', role: 'admin' };
  },
}));
vi.mock('../../packages/api/src/middleware/require-role', () => ({
  requireRole: () => async () => {},
}));

describe('crash routes', () => {
  beforeEach(() => {
    crashServiceMock.queryCrashEvents.mockReset();
    crashServiceMock.getCrashEvent.mockReset();
    crashServiceMock.archiveCrashEvent.mockReset();
    crashServiceMock.archiveHistoricalCrashEvents.mockReset();
    auditServiceMock.logAudit.mockReset();
    auditServiceMock.logAudit.mockResolvedValue(undefined);
  });

  it('archives a single crash event', async () => {
    crashServiceMock.archiveCrashEvent.mockResolvedValue({ success: true, alreadyArchived: false });

    const { crashRoutes } = await import('../../packages/api/src/routes/crash.routes');
    const app = Fastify({ trustProxy: true });
    await app.register(fastifyCookie);
    await app.register(crashRoutes);

    const response = await app.inject({
      method: 'POST',
      url: '/api/crashes/11111111-1111-4111-8111-111111111111/archive',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      success: true,
      data: { archived: true, alreadyArchived: false },
    });
    expect(crashServiceMock.archiveCrashEvent).toHaveBeenCalledWith(
      '11111111-1111-4111-8111-111111111111',
      '11111111-1111-4111-8111-111111111111'
    );

    await app.close();
  });

  it('returns only active events when requested', async () => {
    crashServiceMock.queryCrashEvents.mockResolvedValue({
      events: [],
      total: 0,
    });

    const { crashRoutes } = await import('../../packages/api/src/routes/crash.routes');
    const app = Fastify({ trustProxy: true });
    await app.register(fastifyCookie);
    await app.register(crashRoutes);

    const response = await app.inject({
      method: 'GET',
      url: '/api/crashes?status=active&limit=5',
    });

    expect(response.statusCode).toBe(200);
    expect(crashServiceMock.queryCrashEvents).toHaveBeenCalledWith({
      page: 1,
      limit: 5,
      status: 'active',
    });

    await app.close();
  });
});
