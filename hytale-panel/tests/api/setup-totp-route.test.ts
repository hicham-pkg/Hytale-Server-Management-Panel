import { createRequire } from 'node:module';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { generateCsrfToken } from '../../packages/api/src/utils/csrf';

const apiRequire = createRequire(new URL('../../packages/api/package.json', import.meta.url));
const Fastify = apiRequire('fastify') as typeof import('fastify').default;
const fastifyCookie = apiRequire('@fastify/cookie') as typeof import('@fastify/cookie').default;
const fastifyRateLimit = apiRequire('@fastify/rate-limit') as typeof import('@fastify/rate-limit').default;

const authServiceMock = vi.hoisted(() => ({
  login: vi.fn(),
  validateSession: vi.fn(),
  verifyTotp: vi.fn(),
  destroySession: vi.fn(),
  setupTotp: vi.fn(),
  confirmTotp: vi.fn(),
}));

const auditServiceMock = vi.hoisted(() => ({
  logAudit: vi.fn(),
}));

const middlewareMock = vi.hoisted(() => ({
  requireAuth: vi.fn(),
  requireTotpEnrollmentSession: vi.fn(async (request: any) => {
    request.sessionId = 'pending-admin-session';
    request.currentUser = {
      id: 'admin-user-id',
      username: 'admin',
      role: 'admin',
      totpEnabled: false,
    };
  }),
}));

vi.mock('../../packages/api/src/services/auth.service', () => authServiceMock);
vi.mock('../../packages/api/src/services/audit.service', () => auditServiceMock);
vi.mock('../../packages/api/src/middleware/require-auth', () => middlewareMock);

const originalEnv = { ...process.env };

describe('setup TOTP route', () => {
  beforeEach(() => {
    vi.resetModules();
    authServiceMock.setupTotp.mockReset();
    middlewareMock.requireTotpEnrollmentSession.mockClear();

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
      SESSION_IDLE_TIMEOUT_MINUTES: '60',
      ADMIN_SESSION_IDLE_TIMEOUT_MINUTES: '15',
    };
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it('accepts an explicit empty JSON object without hitting the empty-body parser error', async () => {
    authServiceMock.setupTotp.mockResolvedValue({
      secret: 'totp-secret',
      qrDataUrl: 'data:image/png;base64,abc123',
    });

    const { authRoutes } = await import('../../packages/api/src/routes/auth.routes');
    const { default: csrfPlugin } = await import('../../packages/api/src/plugins/csrf');

    const app = Fastify({ trustProxy: true });
    await app.register(fastifyCookie);
    await app.register(fastifyRateLimit, {
      max: 100,
      timeWindow: 60_000,
    });
    await app.register(csrfPlugin);
    await app.register(authRoutes);

    const sessionId = 'pending-admin-session';
    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/setup-totp',
      headers: {
        cookie: `hytale_session=${sessionId}`,
        'content-type': 'application/json',
        'x-csrf-token': generateCsrfToken('b'.repeat(64), sessionId),
      },
      payload: {},
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      success: true,
      data: {
        secret: 'totp-secret',
        qrDataUrl: 'data:image/png;base64,abc123',
      },
    });
    expect(authServiceMock.setupTotp).toHaveBeenCalledWith('admin-user-id');

    await app.close();
  });
});
