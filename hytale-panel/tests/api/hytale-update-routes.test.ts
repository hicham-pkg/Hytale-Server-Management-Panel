import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';

const apiRequire = createRequire(new URL('../../packages/api/package.json', import.meta.url));
const Fastify = apiRequire('fastify') as typeof import('fastify').default;
const fastifyCookie = apiRequire('@fastify/cookie') as typeof import('@fastify/cookie').default;

const hytaleUpdateMock = vi.hoisted(() => ({
  startHytaleUpdateJob: vi.fn(),
  getHytaleUpdateOverview: vi.fn(),
  latestHytaleUpdateJob: vi.fn(),
  readHytaleUpdateJobStatus: vi.fn(),
  readHytaleUpdateJobLogs: vi.fn(),
}));
const auditMock = vi.hoisted(() => ({ logAudit: vi.fn() }));

vi.mock('../../packages/api/src/services/hytale-update.service', () => hytaleUpdateMock);
vi.mock('../../packages/api/src/services/audit.service', () => auditMock);

const mockUserState: { user: null | { id: string; username: string; role: string; totpEnabled: boolean } } = {
  user: null,
};
vi.mock('../../packages/api/src/middleware/require-auth', () => ({
  requireAuth: async (request: { currentUser?: unknown }, reply: { status: (n: number) => { send: (b: unknown) => void } }) => {
    if (!mockUserState.user) {
      reply.status(401).send({ success: false, error: 'Authentication required' });
      return;
    }
    request.currentUser = mockUserState.user;
  },
}));

const ORIGINAL_ENV = { ...process.env };
const ADMIN = { id: 'admin-id', username: 'admin', role: 'admin', totpEnabled: true };
const READONLY = { id: 'viewer-id', username: 'viewer', role: 'readonly', totpEnabled: true };

async function buildApp() {
  const { hytaleUpdateRoutes } = await import('../../packages/api/src/routes/hytale-update.routes');
  const { ZodError } = await import('zod');
  const app = Fastify();
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ZodError) return reply.status(400).send({ success: false, error: 'Validation error' });
    return reply.status(error.statusCode ?? 500).send({ success: false, error: error.message });
  });
  await app.register(fastifyCookie);
  await app.register(hytaleUpdateRoutes);
  return app;
}

beforeEach(() => {
  vi.resetModules();
  for (const k of Object.keys(hytaleUpdateMock)) {
    (hytaleUpdateMock as Record<string, ReturnType<typeof vi.fn>>)[k].mockReset();
  }
  auditMock.logAudit.mockReset();
  auditMock.logAudit.mockResolvedValue(undefined);
  mockUserState.user = null;
  process.env = {
    ...ORIGINAL_ENV,
    DATABASE_URL: 'postgresql://hytale_panel:password@127.0.0.1:5432/hytale_panel',
    NODE_ENV: 'test',
    SESSION_SECRET: 'a'.repeat(64),
    CSRF_SECRET: 'b'.repeat(64),
    HELPER_HMAC_SECRET: 'c'.repeat(64),
    HYTALE_UPDATE_ENABLED: 'true',
  };
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe('Hytale update routes', () => {
  const mutationRoutes = [
    ['/api/hytale-updates/check', 'check'],
    ['/api/hytale-updates/download', 'download'],
    ['/api/hytale-updates/apply', 'apply'],
    ['/api/hytale-updates/update-now', 'update-now'],
    ['/api/hytale-updates/cancel', 'cancel'],
  ] as const;

  it.each(mutationRoutes)('rejects unauthenticated callers for %s', async (url) => {
    const app = await buildApp();
    const res = await app.inject({ method: 'POST', url, payload: {} });
    expect(res.statusCode).toBe(401);
    expect(hytaleUpdateMock.startHytaleUpdateJob).not.toHaveBeenCalled();
    await app.close();
  });

  it.each(mutationRoutes)('rejects readonly users for %s', async (url) => {
    mockUserState.user = READONLY;
    const app = await buildApp();
    const res = await app.inject({ method: 'POST', url, payload: {} });
    expect(res.statusCode).toBe(403);
    expect(hytaleUpdateMock.startHytaleUpdateJob).not.toHaveBeenCalled();
    await app.close();
  });

  it.each(mutationRoutes)('allows admins to start %s and audits the action', async (url, action) => {
    mockUserState.user = ADMIN;
    hytaleUpdateMock.startHytaleUpdateJob.mockResolvedValue({ success: true, jobId: '11111111-1111-4111-8111-111111111111' });
    const app = await buildApp();
    const res = await app.inject({ method: 'POST', url, payload: {} });
    expect(res.statusCode).toBe(202);
    expect(hytaleUpdateMock.startHytaleUpdateJob).toHaveBeenCalledWith(action);
    expect(auditMock.logAudit).toHaveBeenCalledWith(expect.objectContaining({
      action: `hytale.update_${action.replace('-', '_')}`,
      success: true,
    }));
    await app.close();
  });

  it('starts an admin update-now job and audits success', async () => {
    mockUserState.user = ADMIN;
    hytaleUpdateMock.startHytaleUpdateJob.mockResolvedValue({ success: true, jobId: '11111111-1111-4111-8111-111111111111' });
    const app = await buildApp();
    const res = await app.inject({ method: 'POST', url: '/api/hytale-updates/update-now', payload: {} });
    expect(res.statusCode).toBe(202);
    expect(hytaleUpdateMock.startHytaleUpdateJob).toHaveBeenCalledWith('update-now');
    expect(auditMock.logAudit).toHaveBeenCalledWith(expect.objectContaining({
      action: 'hytale.update_update_now',
      success: true,
    }));
    await app.close();
  });

  it('audits failed apply starts', async () => {
    mockUserState.user = ADMIN;
    hytaleUpdateMock.startHytaleUpdateJob.mockResolvedValue({ success: false, error: 'Another Hytale update job is already running' });
    const app = await buildApp();
    const res = await app.inject({ method: 'POST', url: '/api/hytale-updates/apply', payload: {} });
    expect(res.statusCode).toBe(409);
    expect(auditMock.logAudit).toHaveBeenCalledWith(expect.objectContaining({
      action: 'hytale.update_apply',
      success: false,
    }));
    await app.close();
  });

  it('returns latest job logs without exposing helper internals', async () => {
    mockUserState.user = ADMIN;
    hytaleUpdateMock.readHytaleUpdateJobLogs.mockReturnValue({ content: 'safe log', nextCursor: 8, totalBytes: 8 });
    const app = await buildApp();
    const res = await app.inject({
      method: 'GET',
      url: '/api/hytale-updates/jobs/11111111-1111-4111-8111-111111111111/logs',
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.payload).data.content).toBe('safe log');
    await app.close();
  });
});
