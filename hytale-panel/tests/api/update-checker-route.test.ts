import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';

const apiRequire = createRequire(new URL('../../packages/api/package.json', import.meta.url));
const Fastify = apiRequire('fastify') as typeof import('fastify').default;
const fastifyCookie = apiRequire('@fastify/cookie') as typeof import('@fastify/cookie').default;

const updateCheckerMock = vi.hoisted(() => ({
  getUpdateStatus: vi.fn(),
  compareSemver: vi.fn(),
  getCurrentVersion: vi.fn(),
  _resetCacheForTests: vi.fn(),
}));

const auditMock = vi.hoisted(() => ({
  logAudit: vi.fn(),
}));

vi.mock('../../packages/api/src/services/update-checker.service', () => updateCheckerMock);
vi.mock('../../packages/api/src/services/audit.service', () => auditMock);

// Mock the auth middleware so we can flip the simulated user per test.
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

async function buildAppWithUpdateRoutes() {
  const { systemUpdateRoutes } = await import('../../packages/api/src/routes/system-update.routes');
  const app = Fastify();
  await app.register(fastifyCookie);
  await app.register(systemUpdateRoutes);
  return app;
}

describe('GET /api/system/updates/status', () => {
  beforeEach(() => {
    vi.resetModules();
    updateCheckerMock.getUpdateStatus.mockReset();
    auditMock.logAudit.mockReset();
    mockUserState.user = null;
    process.env = {
      ...ORIGINAL_ENV,
      DATABASE_URL: 'postgresql://hytale_panel:password@127.0.0.1:5432/hytale_panel',
      NODE_ENV: 'test',
      SESSION_SECRET: 'a'.repeat(64),
      CSRF_SECRET: 'b'.repeat(64),
      HELPER_HMAC_SECRET: 'c'.repeat(64),
    };
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it('returns 401 when unauthenticated', async () => {
    mockUserState.user = null;
    const app = await buildAppWithUpdateRoutes();
    const res = await app.inject({ method: 'GET', url: '/api/system/updates/status' });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ success: false, error: 'Authentication required' });
    expect(updateCheckerMock.getUpdateStatus).not.toHaveBeenCalled();
    expect(auditMock.logAudit).not.toHaveBeenCalled();
    await app.close();
  });

  it('returns 403 when authenticated as readonly (non-admin)', async () => {
    mockUserState.user = { id: 'u1', username: 'viewer', role: 'readonly', totpEnabled: true };
    const app = await buildAppWithUpdateRoutes();
    const res = await app.inject({ method: 'GET', url: '/api/system/updates/status' });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ success: false, error: 'Insufficient permissions' });
    expect(updateCheckerMock.getUpdateStatus).not.toHaveBeenCalled();
    expect(auditMock.logAudit).not.toHaveBeenCalled();
    await app.close();
  });

  it('returns 200 with status payload for admin and writes an audit log', async () => {
    mockUserState.user = { id: 'admin-id', username: 'admin', role: 'admin', totpEnabled: true };
    updateCheckerMock.getUpdateStatus.mockResolvedValue({
      currentVersion: '1.1.0',
      latestVersion: '1.1.0',
      latestTag: 'v1.1.0',
      updateAvailable: false,
      releaseUrl: 'https://github.com/owner/repo/releases/tag/v1.1.0',
      releaseName: '1.1.0',
      publishedAt: '2026-04-25T12:00:00Z',
      prerelease: false,
      checkedAt: '2026-04-28T05:00:00Z',
      fromCache: false,
    });

    const app = await buildAppWithUpdateRoutes();
    const res = await app.inject({ method: 'GET', url: '/api/system/updates/status' });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      success: true,
      data: { currentVersion: '1.1.0', latestVersion: '1.1.0', updateAvailable: false },
    });

    expect(auditMock.logAudit).toHaveBeenCalledTimes(1);
    const auditEntry = auditMock.logAudit.mock.calls[0][0];
    expect(auditEntry).toMatchObject({
      userId: 'admin-id',
      action: 'system.update_check',
      success: true,
    });
    expect(auditEntry.details).toMatchObject({
      force: false,
      currentVersion: '1.1.0',
      latestVersion: '1.1.0',
      updateAvailable: false,
    });

    await app.close();
  });

  it('passes force=true through to the service when ?force=true', async () => {
    mockUserState.user = { id: 'admin-id', username: 'admin', role: 'admin', totpEnabled: true };
    updateCheckerMock.getUpdateStatus.mockResolvedValue({
      currentVersion: '1.1.0',
      latestVersion: '1.2.0',
      latestTag: 'v1.2.0',
      updateAvailable: true,
      releaseUrl: 'https://github.com/owner/repo/releases/tag/v1.2.0',
      releaseName: 'patch',
      publishedAt: '2026-05-01T09:00:00Z',
      prerelease: false,
      checkedAt: '2026-04-28T05:00:00Z',
      fromCache: false,
    });

    const app = await buildAppWithUpdateRoutes();
    const res = await app.inject({ method: 'GET', url: '/api/system/updates/status?force=true' });

    expect(res.statusCode).toBe(200);
    expect(updateCheckerMock.getUpdateStatus).toHaveBeenCalledWith({ force: true });
    expect(auditMock.logAudit.mock.calls[0][0].details.force).toBe(true);

    await app.close();
  });

  it('records success=false in the audit log when the service reports an error', async () => {
    mockUserState.user = { id: 'admin-id', username: 'admin', role: 'admin', totpEnabled: true };
    updateCheckerMock.getUpdateStatus.mockResolvedValue({
      currentVersion: '1.1.0',
      latestVersion: null,
      latestTag: null,
      updateAvailable: false,
      releaseUrl: null,
      releaseName: null,
      publishedAt: null,
      prerelease: false,
      checkedAt: '2026-04-28T05:00:00Z',
      fromCache: false,
      error: 'GitHub API responded 503',
    });

    const app = await buildAppWithUpdateRoutes();
    const res = await app.inject({ method: 'GET', url: '/api/system/updates/status' });

    expect(res.statusCode).toBe(200);
    expect(res.json().data.error).toBe('GitHub API responded 503');
    expect(auditMock.logAudit.mock.calls[0][0]).toMatchObject({
      success: false,
      details: expect.objectContaining({ error: 'GitHub API responded 503' }),
    });

    await app.close();
  });

  it('NEVER includes the GitHub token in the response payload, even if env contaminates the request', async () => {
    process.env.GITHUB_UPDATE_TOKEN = 'ghp_super_secret_AAAAAAAA';
    mockUserState.user = { id: 'admin-id', username: 'admin', role: 'admin', totpEnabled: true };
    updateCheckerMock.getUpdateStatus.mockResolvedValue({
      currentVersion: '1.1.0',
      latestVersion: '1.1.0',
      latestTag: 'v1.1.0',
      updateAvailable: false,
      releaseUrl: 'https://github.com/owner/repo',
      releaseName: '1.1.0',
      publishedAt: '2026-04-25T12:00:00Z',
      prerelease: false,
      checkedAt: '2026-04-28T05:00:00Z',
      fromCache: false,
    });

    const app = await buildAppWithUpdateRoutes();
    const res = await app.inject({ method: 'GET', url: '/api/system/updates/status' });

    expect(res.statusCode).toBe(200);
    expect(res.payload).not.toContain('ghp_super_secret');
    expect(res.payload).not.toContain('Authorization');
    // And the audit log must not stash it either.
    expect(JSON.stringify(auditMock.logAudit.mock.calls)).not.toContain('ghp_super_secret');

    await app.close();
  });
});
