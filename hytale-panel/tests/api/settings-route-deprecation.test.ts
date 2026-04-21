import { createRequire } from 'node:module';
import { describe, expect, it, vi } from 'vitest';

const apiRequire = createRequire(new URL('../../packages/api/package.json', import.meta.url));
const Fastify = apiRequire('fastify') as typeof import('fastify').default;
const fastifyCookie = apiRequire('@fastify/cookie') as typeof import('@fastify/cookie').default;

vi.mock('../../packages/api/src/middleware/require-auth', () => ({
  requireAuth: async (request: { currentUser?: { id: string; role: string } }) => {
    request.currentUser = { id: '550e8400-e29b-41d4-a716-446655440001', role: 'admin' };
  },
}));

vi.mock('../../packages/api/src/middleware/require-role', () => ({
  requireRole: () => async () => {},
}));

describe('settings routes deprecation behavior', () => {
  it('returns 410 for GET /api/settings', async () => {
    const { settingsRoutes } = await import('../../packages/api/src/routes/settings.routes');

    const app = Fastify({ trustProxy: true });
    await app.register(fastifyCookie);
    await app.register(settingsRoutes);

    const response = await app.inject({ method: 'GET', url: '/api/settings' });

    expect(response.statusCode).toBe(410);
    expect(response.json()).toEqual({
      success: false,
      error: 'Settings API is deprecated. Configure panel behavior via .env and helper .env files.',
    });

    await app.close();
  });

  it('returns 410 for PUT /api/settings', async () => {
    const { settingsRoutes } = await import('../../packages/api/src/routes/settings.routes');

    const app = Fastify({ trustProxy: true });
    await app.register(fastifyCookie);
    await app.register(settingsRoutes);

    const response = await app.inject({ method: 'PUT', url: '/api/settings', payload: { sessionTimeoutHours: 12 } });

    expect(response.statusCode).toBe(410);
    expect(response.json()).toEqual({
      success: false,
      error: 'Settings API is deprecated. Configure panel behavior via .env and helper .env files.',
    });

    await app.close();
  });
});
