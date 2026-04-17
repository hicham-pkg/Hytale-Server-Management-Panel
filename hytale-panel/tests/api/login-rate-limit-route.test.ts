import { createRequire } from 'node:module';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const apiRequire = createRequire(new URL('../../packages/api/package.json', import.meta.url));
const Fastify = apiRequire('fastify') as typeof import('fastify').default;
const fastifyCookie = apiRequire('@fastify/cookie') as typeof import('@fastify/cookie').default;
const fastifyRateLimit = apiRequire('@fastify/rate-limit') as typeof import('@fastify/rate-limit').default;

const authServiceMock = vi.hoisted(() => ({
  login: vi.fn(),
  verifyTotp: vi.fn(),
  destroySession: vi.fn(),
  setupTotp: vi.fn(),
  confirmTotp: vi.fn(),
}));

const auditServiceMock = vi.hoisted(() => ({
  logAudit: vi.fn(),
}));

vi.mock('../../packages/api/src/services/auth.service', () => authServiceMock);
vi.mock('../../packages/api/src/services/audit.service', () => auditServiceMock);
vi.mock('../../packages/api/src/middleware/require-auth', () => ({
  requireAuth: vi.fn(),
  requireTotpEnrollmentSession: vi.fn(),
}));

const originalEnv = { ...process.env };

describe('Login route rate limiting', () => {
  beforeEach(() => {
    vi.resetModules();
    authServiceMock.login.mockReset();
    auditServiceMock.logAudit.mockReset();

    process.env = {
      ...originalEnv,
      DATABASE_URL: 'postgresql://hytale_panel:password@127.0.0.1:5432/hytale_panel',
      NODE_ENV: 'test',
      SESSION_SECRET: 'a'.repeat(64),
      CSRF_SECRET: 'b'.repeat(64),
      HELPER_HMAC_SECRET: 'c'.repeat(64),
      LOGIN_RATE_LIMIT_MAX: '5',
      LOGIN_RATE_LIMIT_WINDOW_MS: '900000',
      GLOBAL_RATE_LIMIT_MAX: '100',
      GLOBAL_RATE_LIMIT_WINDOW_MS: '60000',
    };
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it('applies the stricter login rate limit on the route itself', async () => {
    authServiceMock.login.mockResolvedValue({
      success: false,
      requires2fa: false,
      error: 'Invalid credentials',
    });

    const { authRoutes } = await import('../../packages/api/src/routes/auth.routes');

    const app = Fastify({ trustProxy: true });
    await app.register(fastifyCookie);
    await app.register(fastifyRateLimit, {
      max: 100,
      timeWindow: 60_000,
    });
    await app.register(authRoutes);

    const statuses: number[] = [];
    for (let attempt = 0; attempt < 6; attempt++) {
      const response = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        remoteAddress: '203.0.113.10',
        headers: { 'user-agent': 'vitest' },
        payload: {
          username: 'admin',
          password: 'wrong-password',
        },
      });

      statuses.push(response.statusCode);
    }

    expect(statuses).toEqual([401, 401, 401, 401, 401, 429]);
    expect(authServiceMock.login).toHaveBeenCalledTimes(5);

    await app.close();
  });
});
