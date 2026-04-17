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

describe('protected API routes', () => {
  beforeEach(() => {
    statsServiceMock.getSystemStats.mockReset();
    statsServiceMock.getProcessStats.mockReset();
  });

  it('rejects a logged-out request to system stats', async () => {
    const { statsRoutes } = await import('../../packages/api/src/routes/stats.routes');

    const app = Fastify({ trustProxy: true });
    await app.register(fastifyCookie);
    await app.register(statsRoutes);

    const response = await app.inject({
      method: 'GET',
      url: '/api/stats/system',
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({
      success: false,
      error: 'Authentication required',
    });
    expect(statsServiceMock.getSystemStats).not.toHaveBeenCalled();

    await app.close();
  });
});
