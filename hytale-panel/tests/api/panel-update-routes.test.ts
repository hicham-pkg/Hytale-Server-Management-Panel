import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const apiRequire = createRequire(new URL('../../packages/api/package.json', import.meta.url));
const Fastify = apiRequire('fastify') as typeof import('fastify').default;
const fastifyCookie = apiRequire('@fastify/cookie') as typeof import('@fastify/cookie').default;

const updateCheckerMock = vi.hoisted(() => ({
  getUpdateStatus: vi.fn(),
}));
const panelUpdateMock = vi.hoisted(() => ({
  startPanelUpdate: vi.fn(),
  rollbackPanelUpdate: vi.fn(),
  readJobStatus: vi.fn(),
  readJobLogs: vi.fn(),
  listJobs: vi.fn(),
  latestJob: vi.fn(),
}));
const auditMock = vi.hoisted(() => ({
  logAudit: vi.fn(),
}));

vi.mock('../../packages/api/src/services/update-checker.service', () => updateCheckerMock);
vi.mock('../../packages/api/src/services/panel-update.service', () => panelUpdateMock);
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
const TMP_JOBS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'panel-update-routes-test-'));

async function buildApp() {
  const { systemUpdateRoutes } = await import('../../packages/api/src/routes/system-update.routes');
  const { ZodError } = await import('zod');
  const app = Fastify();
  // Mirror the production app's Zod-error handler so route-level param/body
  // validation surfaces as 400, not the default 500.
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ZodError) {
      return reply.status(400).send({ success: false, error: 'Validation error' });
    }
    return reply.status(error.statusCode ?? 500).send({ success: false, error: error.message });
  });
  await app.register(fastifyCookie);
  await app.register(systemUpdateRoutes);
  return app;
}

beforeEach(() => {
  vi.resetModules();
  for (const m of [updateCheckerMock, panelUpdateMock, auditMock]) {
    for (const k of Object.keys(m)) (m as Record<string, ReturnType<typeof vi.fn>>)[k].mockReset();
  }
  mockUserState.user = null;
  process.env = {
    ...ORIGINAL_ENV,
    DATABASE_URL: 'postgresql://hytale_panel:password@127.0.0.1:5432/hytale_panel',
    NODE_ENV: 'test',
    SESSION_SECRET: 'a'.repeat(64),
    CSRF_SECRET: 'b'.repeat(64),
    HELPER_HMAC_SECRET: 'c'.repeat(64),
    PANEL_UPDATE_JOBS_DIR: TMP_JOBS_DIR,
    PANEL_UPDATE_INSTALL_ENABLED: 'true',
  };
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

const ADMIN = { id: 'admin-id', username: 'admin', role: 'admin', totpEnabled: true };
const READONLY = { id: 'r-id', username: 'viewer', role: 'readonly', totpEnabled: true };

describe('POST /api/system/updates/start', () => {
  it('rejects unauthenticated callers (401)', async () => {
    mockUserState.user = null;
    const app = await buildApp();
    const res = await app.inject({ method: 'POST', url: '/api/system/updates/start', payload: {} });
    expect(res.statusCode).toBe(401);
    expect(panelUpdateMock.startPanelUpdate).not.toHaveBeenCalled();
    await app.close();
  });

  it('rejects readonly users (403)', async () => {
    mockUserState.user = READONLY;
    const app = await buildApp();
    const res = await app.inject({ method: 'POST', url: '/api/system/updates/start', payload: {} });
    expect(res.statusCode).toBe(403);
    expect(panelUpdateMock.startPanelUpdate).not.toHaveBeenCalled();
    await app.close();
  });

  it('rejects when PANEL_UPDATE_INSTALL_ENABLED=false (kill switch)', async () => {
    process.env.PANEL_UPDATE_INSTALL_ENABLED = 'false';
    mockUserState.user = ADMIN;
    const app = await buildApp();
    const res = await app.inject({ method: 'POST', url: '/api/system/updates/start', payload: {} });
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.payload).error).toMatch(/disabled/i);
    expect(panelUpdateMock.startPanelUpdate).not.toHaveBeenCalled();
    expect(auditMock.logAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'panel.update_start', success: false }),
    );
    await app.close();
  });

  it('returns 409 when no update is available', async () => {
    mockUserState.user = ADMIN;
    updateCheckerMock.getUpdateStatus.mockResolvedValue({
      currentVersion: '1.1.0',
      latestVersion: '1.1.0',
      latestTag: 'v1.1.0',
      checkStatus: 'ok',
      updateAvailable: false,
    });
    const app = await buildApp();
    const res = await app.inject({ method: 'POST', url: '/api/system/updates/start', payload: {} });
    expect(res.statusCode).toBe(409);
    expect(panelUpdateMock.startPanelUpdate).not.toHaveBeenCalled();
    await app.close();
  });

  it('returns 503 when GitHub Releases cannot be checked before starting an update', async () => {
    mockUserState.user = ADMIN;
    updateCheckerMock.getUpdateStatus.mockResolvedValue({
      currentVersion: '1.2.1',
      latestVersion: null,
      latestTag: null,
      checkStatus: 'unable_to_check',
      updateAvailable: false,
      error: 'GitHub API responded 404',
    });
    const app = await buildApp();
    const res = await app.inject({ method: 'POST', url: '/api/system/updates/start', payload: {} });
    expect(res.statusCode).toBe(503);
    expect(res.json().error).toMatch(/Could not check GitHub Releases/);
    expect(res.json().error).not.toMatch(/token|ghp_/i);
    expect(panelUpdateMock.startPanelUpdate).not.toHaveBeenCalled();
    expect(auditMock.logAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'panel.update_start',
        success: false,
        details: expect.objectContaining({ reason: 'update-check-unavailable' }),
      }),
    );
    await app.close();
  });

  it('happy path: forwards to helper service and audits success', async () => {
    mockUserState.user = ADMIN;
    updateCheckerMock.getUpdateStatus.mockResolvedValue({
      currentVersion: '1.1.0',
      latestVersion: '1.2.0',
      latestTag: 'v1.2.0',
      checkStatus: 'ok',
      updateAvailable: true,
    });
    panelUpdateMock.startPanelUpdate.mockResolvedValue({
      success: true,
      jobId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    });
    const app = await buildApp();
    const res = await app.inject({ method: 'POST', url: '/api/system/updates/start', payload: {} });
    expect(res.statusCode).toBe(200);

    // The helper service must be called with the full canonical params —
    // and IMPORTANTLY, the URL must point at the configured repo.
    const call = panelUpdateMock.startPanelUpdate.mock.calls[0][0];
    expect(call.targetTag).toBe('v1.2.0');
    expect(call.tarballType).toBe('tar.gz');
    expect(call.downloadUrl).toMatch(
      /^https:\/\/codeload\.github\.com\/[^/]+\/[^/]+\/tar\.gz\/refs\/tags\/v1\.2\.0$/,
    );
    expect(auditMock.logAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'panel.update_start', success: true }),
    );

    // Sanity: response payload + audit details contain no token.
    process.env.GITHUB_UPDATE_TOKEN = 'ghp_should_not_leak_AAAAAA';
    expect(res.payload).not.toContain('ghp_should_not_leak');
    expect(JSON.stringify(auditMock.logAudit.mock.calls)).not.toContain('ghp_should_not_leak');
    await app.close();
  });
});

describe('POST /api/system/updates/rollback', () => {
  it('rejects readonly users (403)', async () => {
    mockUserState.user = READONLY;
    const app = await buildApp();
    const res = await app.inject({ method: 'POST', url: '/api/system/updates/rollback', payload: {} });
    expect(res.statusCode).toBe(403);
    expect(panelUpdateMock.rollbackPanelUpdate).not.toHaveBeenCalled();
    await app.close();
  });

  it('audits success and forwards backupPath', async () => {
    mockUserState.user = ADMIN;
    panelUpdateMock.rollbackPanelUpdate.mockResolvedValue({
      success: true,
      jobId: 'bbbbbbbb-bbbb-4bbb-9bbb-bbbbbbbbbbbb',
    });
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/system/updates/rollback',
      payload: { backupPath: '/opt/hytale-panel-backups/20260501T000000Z' },
    });
    expect(res.statusCode).toBe(200);
    expect(panelUpdateMock.rollbackPanelUpdate).toHaveBeenCalledWith({
      backupPath: '/opt/hytale-panel-backups/20260501T000000Z',
    });
    expect(auditMock.logAudit.mock.calls[0][0]).toMatchObject({
      action: 'panel.update_rollback',
      success: true,
    });
    await app.close();
  });
});

describe('GET /api/system/updates/jobs/:jobId', () => {
  it('rejects non-uuid job IDs as 400', async () => {
    mockUserState.user = ADMIN;
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/api/system/updates/jobs/not-a-uuid' });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('returns 404 if the service can\'t find the job', async () => {
    mockUserState.user = ADMIN;
    panelUpdateMock.readJobStatus.mockReturnValue(null);
    const app = await buildApp();
    const res = await app.inject({
      method: 'GET',
      url: '/api/system/updates/jobs/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it('returns the status from the service for a valid uuid', async () => {
    mockUserState.user = ADMIN;
    panelUpdateMock.readJobStatus.mockReturnValue({
      jobId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      kind: 'update',
      step: 3,
      stepName: 'preflight',
      totalSteps: 8,
      status: 'running',
      startedAt: '2026-04-28T00:00:00Z',
      endedAt: null,
      error: null,
    });
    const app = await buildApp();
    const res = await app.inject({
      method: 'GET',
      url: '/api/system/updates/jobs/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.payload).data.stepName).toBe('preflight');
    await app.close();
  });
});

describe('GET /api/system/updates/jobs/:jobId/logs', () => {
  it('rejects non-uuid job IDs as 400', async () => {
    mockUserState.user = ADMIN;
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/api/system/updates/jobs/not-a-uuid/logs' });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('returns the log tail from the service', async () => {
    mockUserState.user = ADMIN;
    panelUpdateMock.readJobLogs.mockReturnValue({
      content: 'building...\n',
      nextCursor: 12,
      totalBytes: 12,
    });
    const app = await buildApp();
    const res = await app.inject({
      method: 'GET',
      url: '/api/system/updates/jobs/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/logs?cursor=0',
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.payload).data.content).toBe('building...\n');
    await app.close();
  });
});

describe('Hardening — API container does not run privileged ops', () => {
  it('the route file does not import child_process / spawn / sudo / docker / systemctl', () => {
    const src = fs.readFileSync(
      path.resolve(__dirname, '../../packages/api/src/routes/system-update.routes.ts'),
      'utf8',
    );
    expect(src).not.toMatch(/from\s+['"]child_process['"]/);
    expect(src).not.toMatch(/\bspawn\b\s*\(/);
    expect(src).not.toMatch(/\bexecFile\b\s*\(/);
    expect(src).not.toMatch(/\bsudo\b/);
    expect(src).not.toMatch(/systemctl/);
    expect(src).not.toMatch(/docker compose/);
  });
});
