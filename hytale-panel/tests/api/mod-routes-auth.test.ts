import { createRequire } from 'node:module';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const apiRequire = createRequire(new URL('../../packages/api/package.json', import.meta.url));
const Fastify = apiRequire('fastify') as typeof import('fastify').default;
const fastifyCookie = apiRequire('@fastify/cookie') as typeof import('@fastify/cookie').default;

const adminUserId = '550e8400-e29b-41d4-a716-446655440001';
const validStagedId = '550e8400-e29b-41d4-a716-4466554400aa';
const validSha256 = 'a'.repeat(64);

const modServiceMock = vi.hoisted(() => ({
  listMods: vi.fn(),
  stageModUpload: vi.fn(),
  installStagedMod: vi.fn(),
  disableMod: vi.fn(),
  enableMod: vi.fn(),
  removeMod: vi.fn(),
  backupMods: vi.fn(),
  rollbackMods: vi.fn(),
  restartAndVerifyMods: vi.fn(),
}));

const auditServiceMock = vi.hoisted(() => ({
  logAudit: vi.fn(),
}));

vi.mock('../../packages/api/src/services/mod.service', () => modServiceMock);
vi.mock('../../packages/api/src/services/audit.service', () => auditServiceMock);
vi.mock('../../packages/api/src/services/helper-client', () => ({
  isHelperUnavailableError: () => false,
}));
vi.mock('../../packages/api/src/config', () => ({
  getConfig: () => ({
    maxModUploadSizeMb: 150,
    modUploadStagingPath: '/opt/hytale-panel-data/mod-upload-staging',
  }),
}));
vi.mock('../../packages/api/src/middleware/require-auth', () => ({
  requireAuth: async (
    request: { headers: Record<string, string | string[] | undefined>; currentUser?: { id: string; role: string } },
    reply: { status: (code: number) => { send: (payload: unknown) => unknown } }
  ) => {
    const role = request.headers['x-test-role'];
    if (typeof role !== 'string') {
      return reply.status(401).send({ success: false, error: 'Authentication required' });
    }
    request.currentUser = { id: adminUserId, role };
  },
}));
vi.mock('../../packages/api/src/middleware/require-role', () => ({
  requireRole: (...allowedRoles: string[]) => async (
    request: { currentUser?: { role: string } },
    reply: { status: (code: number) => { send: (payload: unknown) => unknown } }
  ) => {
    if (!request.currentUser || !allowedRoles.includes(request.currentUser.role)) {
      return reply.status(403).send({ success: false, error: 'Forbidden' });
    }
  },
}));

async function buildApp() {
  const { modRoutes } = await import('../../packages/api/src/routes/mod.routes');
  const app = Fastify({ trustProxy: true });
  await app.register(fastifyCookie);
  await app.register(modRoutes);
  return app;
}

type InjectRequest = {
  method: 'GET' | 'POST' | 'DELETE';
  url: string;
  payload?: unknown;
  headers?: Record<string, string>;
};

const mutationRequests: InjectRequest[] = [
  {
    method: 'POST',
    url: '/api/mods/upload',
    headers: {
      'content-type': 'application/octet-stream',
      'x-mod-filename': 'safe.jar',
      'content-length': '8',
    },
    payload: Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x00, 0x00]),
  },
  {
    method: 'POST',
    url: '/api/mods/install',
    payload: {
      stagedId: validStagedId,
      sanitizedName: 'safe.jar',
      sha256: validSha256,
    },
  },
  { method: 'POST', url: '/api/mods/safe.jar/disable' },
  { method: 'POST', url: '/api/mods/safe.jar/enable' },
  { method: 'DELETE', url: '/api/mods/safe.jar?confirm=safe.jar' },
  { method: 'POST', url: '/api/mods/backup' },
  { method: 'POST', url: '/api/mods/rollback', payload: {} },
  { method: 'POST', url: '/api/mods/restart-apply', payload: {} },
];

describe('mods routes authentication and authorization', () => {
  beforeEach(() => {
    Object.values(modServiceMock).forEach((mock) => mock.mockReset());
    auditServiceMock.logAudit.mockReset();
    auditServiceMock.logAudit.mockResolvedValue(undefined);
    modServiceMock.listMods.mockResolvedValue({ active: [], disabled: [] });
  });

  it('rejects unauthenticated access to every mods route before calling the service layer', async () => {
    const app = await buildApp();

    for (const request of [{ method: 'GET', url: '/api/mods' } as InjectRequest, ...mutationRequests]) {
      const response = await app.inject(request);
      expect(response.statusCode).toBe(401);
    }

    Object.values(modServiceMock).forEach((mock) => expect(mock).not.toHaveBeenCalled());
    await app.close();
  });

  it('allows readonly users to list mods without exposing mutation access', async () => {
    const app = await buildApp();

    const response = await app.inject({
      method: 'GET',
      url: '/api/mods',
      headers: { 'x-test-role': 'readonly' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ success: true, data: { active: [], disabled: [] } });
    expect(modServiceMock.listMods).toHaveBeenCalledTimes(1);
    await app.close();
  });

  it('rejects readonly users from every mods mutation route before calling the service layer', async () => {
    const app = await buildApp();

    for (const request of mutationRequests) {
      const response = await app.inject({
        ...request,
        headers: { ...request.headers, 'x-test-role': 'readonly' },
      });
      expect(response.statusCode).toBe(403);
    }

    expect(modServiceMock.stageModUpload).not.toHaveBeenCalled();
    expect(modServiceMock.installStagedMod).not.toHaveBeenCalled();
    expect(modServiceMock.disableMod).not.toHaveBeenCalled();
    expect(modServiceMock.enableMod).not.toHaveBeenCalled();
    expect(modServiceMock.removeMod).not.toHaveBeenCalled();
    expect(modServiceMock.backupMods).not.toHaveBeenCalled();
    expect(modServiceMock.rollbackMods).not.toHaveBeenCalled();
    expect(modServiceMock.restartAndVerifyMods).not.toHaveBeenCalled();
    await app.close();
  });
});
