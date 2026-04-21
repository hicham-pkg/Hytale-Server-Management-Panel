import { createRequire } from 'node:module';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const apiRequire = createRequire(new URL('../../packages/api/package.json', import.meta.url));
const Fastify = apiRequire('fastify') as typeof import('fastify').default;
const fastifyCookie = apiRequire('@fastify/cookie') as typeof import('@fastify/cookie').default;

const consoleServiceMock = vi.hoisted(() => ({
  captureConsoleOutput: vi.fn(),
  readLogs: vi.fn(),
}));

vi.mock('../../packages/api/src/services/console.service', () => consoleServiceMock);
vi.mock('../../packages/api/src/middleware/require-auth', () => ({
  requireAuth: async (request: { currentUser?: { id: number; role: string } }) => {
    request.currentUser = { id: 1, role: 'admin' };
  },
}));

describe('console routes degraded helper handling', () => {
  beforeEach(() => {
    consoleServiceMock.captureConsoleOutput.mockReset();
    consoleServiceMock.readLogs.mockReset();
  });

  it('returns degraded helper state for log reads when helper is unavailable', async () => {
    const { HelperUnavailableError } = await import('../../packages/api/src/services/helper-client');
    consoleServiceMock.readLogs.mockRejectedValue(
      new HelperUnavailableError('logs.read', 'Helper request timed out for logs.read')
    );

    const { consoleRoutes } = await import('../../packages/api/src/routes/console.routes');

    const app = Fastify({ trustProxy: true });
    await app.register(fastifyCookie);
    await app.register(consoleRoutes);

    const response = await app.inject({
      method: 'GET',
      url: '/api/console/logs?lines=100',
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

  it('returns 409 when console capture fails without a transport outage', async () => {
    consoleServiceMock.captureConsoleOutput.mockResolvedValue({
      success: false,
      lines: [],
      error: 'tmux session not found',
    });

    const { consoleRoutes } = await import('../../packages/api/src/routes/console.routes');

    const app = Fastify({ trustProxy: true });
    await app.register(fastifyCookie);
    await app.register(consoleRoutes);

    const response = await app.inject({
      method: 'GET',
      url: '/api/console/history?lines=10',
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({
      success: false,
      data: {
        lines: [],
      },
      error: 'tmux session not found',
    });

    await app.close();
  });
});
