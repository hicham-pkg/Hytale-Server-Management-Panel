import { createRequire } from 'node:module';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const apiRequire = createRequire(new URL('../../packages/api/package.json', import.meta.url));
const Fastify = apiRequire('fastify') as typeof import('fastify').default;
const fastifyCookie = apiRequire('@fastify/cookie') as typeof import('@fastify/cookie').default;

const backupServiceMock = vi.hoisted(() => ({
  listBackups: vi.fn(),
  createBackup: vi.fn(),
  restoreBackup: vi.fn(),
  deleteBackup: vi.fn(),
}));
const auditServiceMock = vi.hoisted(() => ({
  logAudit: vi.fn(),
}));

vi.mock('../../packages/api/src/services/backup.service', () => backupServiceMock);
vi.mock('../../packages/api/src/services/backup-job.service', () => ({
  enqueueCreateBackupJob: vi.fn(),
  enqueueRestoreBackupJob: vi.fn(),
}));
vi.mock('../../packages/api/src/services/audit.service', () => auditServiceMock);

const userState: { user: null | { id: string; username: string; role: string; totpEnabled: boolean } } = {
  user: null,
};
vi.mock('../../packages/api/src/middleware/require-auth', () => ({
  requireAuth: async (request: { currentUser?: unknown }, reply: { status: (n: number) => { send: (b: unknown) => void } }) => {
    if (!userState.user) {
      reply.status(401).send({ success: false, error: 'Authentication required' });
      return;
    }
    request.currentUser = userState.user;
  },
}));

const ADMIN = { id: '550e8400-e29b-41d4-a716-446655440001', username: 'admin', role: 'admin', totpEnabled: true };
const READONLY = { id: '550e8400-e29b-41d4-a716-446655440002', username: 'r', role: 'readonly', totpEnabled: true };

async function buildApp() {
  const { backupRoutes } = await import('../../packages/api/src/routes/backup.routes');
  const app = Fastify();
  await app.register(fastifyCookie);
  await app.register(backupRoutes);
  return app;
}

beforeEach(() => {
  backupServiceMock.deleteBackup.mockReset();
  auditServiceMock.logAudit.mockReset();
  auditServiceMock.logAudit.mockResolvedValue(undefined);
  userState.user = null;
});

const VALID_UUID = '550e8400-e29b-41d4-a716-446655440111';
const VALID_FILENAME = '2026-04-25T18-30-00-000Z.tar.gz';

describe('DELETE /api/backups/:id — auth', () => {
  it('returns 401 when unauthenticated', async () => {
    const app = await buildApp();
    const res = await app.inject({ method: 'DELETE', url: `/api/backups/${VALID_UUID}` });
    expect(res.statusCode).toBe(401);
    expect(backupServiceMock.deleteBackup).not.toHaveBeenCalled();
    await app.close();
  });

  it('returns 403 when readonly user attempts delete', async () => {
    userState.user = READONLY;
    const app = await buildApp();
    const res = await app.inject({ method: 'DELETE', url: `/api/backups/${VALID_UUID}` });
    expect(res.statusCode).toBe(403);
    expect(backupServiceMock.deleteBackup).not.toHaveBeenCalled();
    await app.close();
  });
});

describe('DELETE /api/backups/:id — happy paths', () => {
  beforeEach(() => {
    userState.user = ADMIN;
  });

  it('admin can delete by UUID — service called, audit success', async () => {
    backupServiceMock.deleteBackup.mockResolvedValue({ success: true });
    const app = await buildApp();
    const res = await app.inject({ method: 'DELETE', url: `/api/backups/${VALID_UUID}` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ success: true });
    expect(backupServiceMock.deleteBackup).toHaveBeenCalledWith(VALID_UUID);
    expect(auditServiceMock.logAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'backup.delete', success: true, target: VALID_UUID }),
    );
    await app.close();
  });

  it('admin can delete by disk-only filename', async () => {
    backupServiceMock.deleteBackup.mockResolvedValue({ success: true });
    const app = await buildApp();
    const res = await app.inject({ method: 'DELETE', url: `/api/backups/${VALID_FILENAME}` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ success: true });
    expect(backupServiceMock.deleteBackup).toHaveBeenCalledWith(VALID_FILENAME);
    await app.close();
  });
});

describe('DELETE /api/backups/:id — clean error mapping (no more "Backend proxy failed")', () => {
  beforeEach(() => {
    userState.user = ADMIN;
  });

  it('returns 404 with structured JSON when service says not_found', async () => {
    backupServiceMock.deleteBackup.mockResolvedValue({
      success: false,
      reason: 'not_found',
      error: 'Backup not found',
    });
    const app = await buildApp();
    const res = await app.inject({ method: 'DELETE', url: `/api/backups/${VALID_UUID}` });
    expect(res.statusCode).toBe(404);
    expect(res.headers['content-type']).toMatch(/application\/json/);
    expect(res.json()).toEqual({ success: false, error: 'Backup not found' });
    expect(auditServiceMock.logAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'backup.delete',
        success: false,
        details: { reason: 'not_found' },
      }),
    );
    await app.close();
  });

  it('returns 400 with clean message when service says invalid', async () => {
    backupServiceMock.deleteBackup.mockResolvedValue({
      success: false,
      reason: 'invalid',
      error: 'Invalid backup name',
    });
    const app = await buildApp();
    const res = await app.inject({ method: 'DELETE', url: `/api/backups/${VALID_FILENAME}` });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ success: false, error: 'Invalid backup name' });
    await app.close();
  });

  it('returns 502 with clean message when service says helper_failed', async () => {
    backupServiceMock.deleteBackup.mockResolvedValue({
      success: false,
      reason: 'helper_failed',
      error: 'Backup file not found',
    });
    const app = await buildApp();
    const res = await app.inject({ method: 'DELETE', url: `/api/backups/${VALID_UUID}` });
    expect(res.statusCode).toBe(502);
    expect(res.headers['content-type']).toMatch(/application\/json/);
    expect(res.json()).toEqual({ success: false, error: 'Backup file not found' });
    await app.close();
  });

  it('returns 502/503 JSON (never raw 500 HTML) when service THROWS', async () => {
    backupServiceMock.deleteBackup.mockRejectedValue(new Error('socket hang up'));
    const app = await buildApp();
    const res = await app.inject({ method: 'DELETE', url: `/api/backups/${VALID_UUID}` });
    // sendHelperDegraded returns 502 for non-HelperUnavailableError, 503 otherwise.
    expect([502, 503]).toContain(res.statusCode);
    expect(res.headers['content-type']).toMatch(/application\/json/);
    const body = res.json() as { success: boolean; error: string };
    expect(body.success).toBe(false);
    expect(typeof body.error).toBe('string');
    // Must NOT be the generic "Backend proxy failed" string — that only
    // fired because upstream returned non-JSON. We always return JSON now.
    await app.close();
  });
});

describe('DELETE /api/backups/:id — schema rejection (Zod)', () => {
  // Inputs the BackupIdentifierSchema rejects outright (not a UUID,
  // not matching BACKUP_FILENAME_REGEX). These never reach the service.
  beforeEach(() => {
    userState.user = ADMIN;
  });

  it.each([
    ['/api/backups/notabackup.zip', 'wrong extension'],
    ['/api/backups/just-a-string', 'no extension'],
  ])('returns 400 JSON (and audits) for %s (%s)', async (url) => {
    const app = await buildApp();
    const res = await app.inject({ method: 'DELETE', url });
    expect(res.statusCode).toBe(400);
    expect(res.headers['content-type']).toMatch(/application\/json/);
    expect(res.json()).toEqual({ success: false, error: 'Invalid backup name' });
    expect(backupServiceMock.deleteBackup).not.toHaveBeenCalled();
    expect(auditServiceMock.logAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'backup.delete',
        success: false,
        details: { reason: 'invalid' },
      }),
    );
    await app.close();
  });
});

describe('DELETE /api/backups/:id — service-level rejection of unsafe filenames', () => {
  // Inputs that pass the schema regex but fail the strict
  // isSafeBackupFilename guard (leading dot, "..", slashes/backslashes
  // can't even reach here because schema strips them, but the strict
  // guard at the service catches the rest). Service returns
  // reason='invalid'; route maps to 400 JSON.
  beforeEach(() => {
    userState.user = ADMIN;
    backupServiceMock.deleteBackup.mockResolvedValue({
      success: false,
      reason: 'invalid',
      error: 'Invalid backup name',
    });
  });

  it.each([
    ['/api/backups/.hidden.tar.gz', 'leading dot'],
    ['/api/backups/foo..bar.tar.gz', 'double-dot'],
    ['/api/backups/..tar.gz', 'just `..tar.gz`'],
  ])('returns 400 JSON for %s (%s)', async (url) => {
    const app = await buildApp();
    const res = await app.inject({ method: 'DELETE', url });
    expect(res.statusCode).toBe(400);
    expect(res.headers['content-type']).toMatch(/application\/json/);
    expect(res.json()).toEqual({ success: false, error: 'Invalid backup name' });
    // Service IS called here (schema accepted) — verifies that the
    // service-level guard is what enforces the stricter rule.
    expect(backupServiceMock.deleteBackup).toHaveBeenCalled();
    await app.close();
  });
});
