import { createRequire } from 'node:module';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const apiRequire = createRequire(new URL('../../packages/api/package.json', import.meta.url));
const Fastify = apiRequire('fastify') as typeof import('fastify').default;
const fastifyCookie = apiRequire('@fastify/cookie') as typeof import('@fastify/cookie').default;

const statsServiceMock = vi.hoisted(() => ({
  getSystemStats: vi.fn(),
  getProcessStats: vi.fn(),
}));

vi.mock('../../packages/api/src/services/stats.service', () => statsServiceMock);
vi.mock('../../packages/api/src/middleware/require-auth', () => ({
  requireAuth: async (request: { currentUser?: { id: number; role: string } }) => {
    request.currentUser = { id: 1, role: 'admin' };
  },
}));

describe('stats routes degraded helper handling', () => {
  beforeEach(() => {
    statsServiceMock.getSystemStats.mockReset();
    statsServiceMock.getProcessStats.mockReset();
  });

  it('returns degraded helper state for system stats when helper is unavailable', async () => {
    const { HelperUnavailableError } = await import('../../packages/api/src/services/helper-client');
    statsServiceMock.getSystemStats.mockRejectedValue(
      new HelperUnavailableError('stats.system', 'Helper request timed out for stats.system')
    );

    const { statsRoutes } = await import('../../packages/api/src/routes/stats.routes');
    const app = Fastify({ trustProxy: true });
    await app.register(fastifyCookie);
    await app.register(statsRoutes);

    const response = await app.inject({
      method: 'GET',
      url: '/api/stats/system',
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
});
