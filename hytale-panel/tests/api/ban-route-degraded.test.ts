import { createRequire } from 'node:module';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const apiRequire = createRequire(new URL('../../packages/api/package.json', import.meta.url));
const Fastify = apiRequire('fastify') as typeof import('fastify').default;
const fastifyCookie = apiRequire('@fastify/cookie') as typeof import('@fastify/cookie').default;

const banServiceMock = vi.hoisted(() => ({
  getBans: vi.fn(),
  addBan: vi.fn(),
  removeBan: vi.fn(),
}));

const serverServiceMock = vi.hoisted(() => ({
  getServerStatus: vi.fn(),
}));

vi.mock('../../packages/api/src/services/ban.service', () => banServiceMock);
vi.mock('../../packages/api/src/services/server.service', () => serverServiceMock);
vi.mock('../../packages/api/src/middleware/require-auth', () => ({
  requireAuth: async (request: { currentUser?: { id: number; role: string } }) => {
    request.currentUser = { id: 1, role: 'admin' };
  },
}));
vi.mock('../../packages/api/src/middleware/require-role', () => ({
  requireRole: () => async () => {},
}));
vi.mock('../../packages/api/src/services/audit.service', () => ({
  logAudit: vi.fn().mockResolvedValue(undefined),
}));

describe('ban routes degraded helper handling', () => {
  beforeEach(() => {
    banServiceMock.getBans.mockReset();
    banServiceMock.addBan.mockReset();
    banServiceMock.removeBan.mockReset();
    serverServiceMock.getServerStatus.mockReset();
  });

  it('returns degraded helper state for ban list reads when helper is unavailable', async () => {
    const { HelperUnavailableError } = await import('../../packages/api/src/services/helper-client');
    banServiceMock.getBans.mockRejectedValue(
      new HelperUnavailableError('bans.read', 'Helper request timed out for bans.read')
    );

    const { banRoutes } = await import('../../packages/api/src/routes/ban.routes');

    const app = Fastify({ trustProxy: true });
    await app.register(fastifyCookie);
    await app.register(banRoutes);

    const response = await app.inject({
      method: 'GET',
      url: '/api/bans',
    });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({
      success: false,
      error: 'Helper service unavailable',
      data: {
        message: 'Unable to verify live server state',
        degraded: true,
        dependency: 'helper',
      },
    });

    await app.close();
  });

  it('returns 409 when live ban command fails while server is running', async () => {
    serverServiceMock.getServerStatus.mockResolvedValue({ running: true });
    banServiceMock.addBan.mockResolvedValue({
      success: false,
      message: 'Server is running; live ban command failed. File was not modified.',
    });

    const { banRoutes } = await import('../../packages/api/src/routes/ban.routes');

    const app = Fastify({ trustProxy: true });
    await app.register(fastifyCookie);
    await app.register(banRoutes);

    const response = await app.inject({
      method: 'POST',
      url: '/api/bans/add',
      payload: { name: 'TestPlayer', reason: '' },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({
      success: false,
      data: {
        message: 'Server is running; live ban command failed. File was not modified.',
      },
      error: 'Server is running; live ban command failed. File was not modified.',
    });

    await app.close();
  });
});
