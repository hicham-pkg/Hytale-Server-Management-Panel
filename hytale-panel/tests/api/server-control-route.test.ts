import { createRequire } from 'node:module';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const apiRequire = createRequire(new URL('../../packages/api/package.json', import.meta.url));
const Fastify = apiRequire('fastify') as typeof import('fastify').default;
const fastifyCookie = apiRequire('@fastify/cookie') as typeof import('@fastify/cookie').default;

const serverServiceMock = vi.hoisted(() => ({
  startServer: vi.fn(),
  stopServer: vi.fn(),
  restartServer: vi.fn(),
  getServerStatus: vi.fn(),
}));

const auditServiceMock = vi.hoisted(() => ({
  logAudit: vi.fn(),
}));

vi.mock('../../packages/api/src/services/server.service', () => serverServiceMock);
vi.mock('../../packages/api/src/services/audit.service', () => auditServiceMock);
vi.mock('../../packages/api/src/middleware/require-auth', () => ({
  requireAuth: async (request: { currentUser?: { id: number; role: string } }) => {
    request.currentUser = { id: 1, role: 'admin' };
  },
}));
vi.mock('../../packages/api/src/middleware/require-role', () => ({
  requireRole: () => async () => {},
}));

describe('server control routes', () => {
  beforeEach(() => {
    serverServiceMock.startServer.mockReset();
    serverServiceMock.stopServer.mockReset();
    serverServiceMock.restartServer.mockReset();
    serverServiceMock.getServerStatus.mockReset();
    auditServiceMock.logAudit.mockReset();
    auditServiceMock.logAudit.mockResolvedValue(undefined);
  });

  it('returns 409 when start fails to produce a managed runtime', async () => {
    serverServiceMock.startServer.mockResolvedValue({
      success: false,
      message: 'Start command returned, but no managed Hytale Java runtime appeared on the shared tmux socket. Run scripts/doctor.sh --repair on the VPS.',
    });

    const { serverRoutes } = await import('../../packages/api/src/routes/server.routes');

    const app = Fastify({ trustProxy: true });
    await app.register(fastifyCookie);
    await app.register(serverRoutes);

    const response = await app.inject({
      method: 'POST',
      url: '/api/server/start',
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({
      success: false,
      data: {
        message: 'Start command returned, but no managed Hytale Java runtime appeared on the shared tmux socket. Run scripts/doctor.sh --repair on the VPS.',
      },
      error: 'Start command returned, but no managed Hytale Java runtime appeared on the shared tmux socket. Run scripts/doctor.sh --repair on the VPS.',
    });

    await app.close();
  });
});
