import { createRequire } from 'node:module';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const apiRequire = createRequire(new URL('../../packages/api/package.json', import.meta.url));
const Fastify = apiRequire('fastify') as typeof import('fastify').default;
const fastifyCookie = apiRequire('@fastify/cookie') as typeof import('@fastify/cookie').default;

const whitelistServiceMock = vi.hoisted(() => ({
  getWhitelist: vi.fn(),
  addPlayer: vi.fn(),
  removePlayerOnline: vi.fn(),
  removePlayerOffline: vi.fn(),
  toggleWhitelist: vi.fn(),
}));

const serverServiceMock = vi.hoisted(() => ({
  getServerStatus: vi.fn(),
}));

const auditServiceMock = vi.hoisted(() => ({
  logAudit: vi.fn(),
}));

vi.mock('../../packages/api/src/services/whitelist.service', () => whitelistServiceMock);
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

describe('whitelist routes degraded helper handling', () => {
  beforeEach(() => {
    whitelistServiceMock.getWhitelist.mockReset();
    whitelistServiceMock.addPlayer.mockReset();
    whitelistServiceMock.removePlayerOnline.mockReset();
    whitelistServiceMock.removePlayerOffline.mockReset();
    whitelistServiceMock.toggleWhitelist.mockReset();
    serverServiceMock.getServerStatus.mockReset();
    auditServiceMock.logAudit.mockReset();
    auditServiceMock.logAudit.mockResolvedValue(undefined);
  });

  it('uses strict status checks and returns degraded state when helper status is unavailable', async () => {
    whitelistServiceMock.getWhitelist.mockResolvedValue({
      success: true,
      enabled: true,
      list: [],
    });
    const { HelperUnavailableError } = await import('../../packages/api/src/services/helper-client');
    serverServiceMock.getServerStatus.mockRejectedValue(
      new HelperUnavailableError('server.status', 'Helper request timed out for server.status')
    );

    const { whitelistRoutes } = await import('../../packages/api/src/routes/whitelist.routes');

    const app = Fastify({ trustProxy: true });
    await app.register(fastifyCookie);
    await app.register(whitelistRoutes);

    const response = await app.inject({
      method: 'GET',
      url: '/api/whitelist',
    });

    expect(serverServiceMock.getServerStatus).toHaveBeenCalledWith({ strict: true });
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

  it('returns 409 when whitelist file read fails with a domain error', async () => {
    whitelistServiceMock.getWhitelist.mockResolvedValue({
      success: false,
      enabled: false,
      list: [],
      error: 'Whitelist file is invalid JSON',
    });

    const { whitelistRoutes } = await import('../../packages/api/src/routes/whitelist.routes');

    const app = Fastify({ trustProxy: true });
    await app.register(fastifyCookie);
    await app.register(whitelistRoutes);

    const response = await app.inject({
      method: 'GET',
      url: '/api/whitelist',
    });

    expect(serverServiceMock.getServerStatus).not.toHaveBeenCalled();
    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({
      success: false,
      error: 'Whitelist file is invalid JSON',
    });

    await app.close();
  });

  it('returns 409 when whitelist add fails due to runtime preconditions', async () => {
    serverServiceMock.getServerStatus.mockResolvedValue({ running: false });
    whitelistServiceMock.addPlayer.mockResolvedValue({
      success: false,
      message:
        'Cannot add players by name while the server is stopped. The whitelist file stores UUIDs, and name-to-UUID resolution requires a running server. Start the server first, then add the player.',
    });

    const { whitelistRoutes } = await import('../../packages/api/src/routes/whitelist.routes');

    const app = Fastify({ trustProxy: true });
    await app.register(fastifyCookie);
    await app.register(whitelistRoutes);

    const response = await app.inject({
      method: 'POST',
      url: '/api/whitelist/add',
      payload: { name: 'TestPlayer' },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({
      success: false,
      data: {
        message:
          'Cannot add players by name while the server is stopped. The whitelist file stores UUIDs, and name-to-UUID resolution requires a running server. Start the server first, then add the player.',
      },
      error:
        'Cannot add players by name while the server is stopped. The whitelist file stores UUIDs, and name-to-UUID resolution requires a running server. Start the server first, then add the player.',
    });

    await app.close();
  });
});
