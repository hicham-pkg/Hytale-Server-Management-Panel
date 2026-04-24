import { createRequire } from 'node:module';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const apiRequire = createRequire(new URL('../../packages/api/package.json', import.meta.url));
const Fastify = apiRequire('fastify') as typeof import('fastify').default;
const fastifyCookie = apiRequire('@fastify/cookie') as typeof import('@fastify/cookie').default;

const dbState = vi.hoisted(() => ({
  updatedRows: [] as Array<{ id: string }>,
  deletedRows: [] as Array<{ id: string }>,
  targetUserRows: [] as Array<{ id: string; role: string }>,
  adminCountRows: [{ count: 1 }] as Array<{ count: number }>,
}));

const updateReturningMock = vi.hoisted(() => vi.fn());
const deleteReturningMock = vi.hoisted(() => vi.fn());
const deleteWhereMock = vi.hoisted(() => vi.fn());
const selectLimitMock = vi.hoisted(() => vi.fn());
const selectWhereNoLimitMock = vi.hoisted(() => vi.fn());
const executeMock = vi.hoisted(() => vi.fn());

const schemaMock = vi.hoisted(() => ({
  users: {
    id: 'users.id',
    username: 'users.username',
    role: 'users.role',
    totpEnabled: 'users.totp_enabled',
    createdAt: 'users.created_at',
    updatedAt: 'users.updated_at',
  },
  sessions: {
    userId: 'sessions.user_id',
  },
}));

const dbMock = vi.hoisted(() => {
  const mock = {
    execute: executeMock,
    select: vi.fn((selection?: unknown) => ({
      from: vi.fn(() => ({
        where: vi.fn(() => {
          // Two shapes: { count }.from(users).where(...)  -> returns adminCountRows
          //             { id, role }.from(users).where(...).limit(1) -> targetUserRows
          const isCountShape =
            selection && typeof selection === 'object' && 'count' in (selection as Record<string, unknown>);
          if (isCountShape) {
            return selectWhereNoLimitMock();
          }
          return {
            limit: selectLimitMock,
          };
        }),
      })),
    })),
    update: vi.fn(() => ({
      set: vi.fn(() => ({
        where: vi.fn(() => ({
          returning: updateReturningMock,
        })),
      })),
    })),
    delete: vi.fn((table: unknown) => {
      if (table === schemaMock.sessions) {
        return {
          where: deleteWhereMock,
        };
      }

      return {
        where: vi.fn(() => ({
          returning: deleteReturningMock,
        })),
      };
    }),
    transaction: vi.fn(),
  };
  mock.transaction.mockImplementation(async (callback: (tx: typeof mock) => unknown) => callback(mock));
  return mock;
});

const logAuditMock = vi.hoisted(() => vi.fn());

vi.mock('drizzle-orm', () => ({
  eq: vi.fn(() => ({})),
  and: vi.fn(() => ({})),
  ne: vi.fn(() => ({})),
  sql: Object.assign(vi.fn(() => ({})), { raw: vi.fn(() => ({})) }),
}));

vi.mock('../../packages/api/src/db', () => ({
  getDb: () => dbMock,
  schema: schemaMock,
}));

vi.mock('../../packages/api/src/middleware/require-auth', () => ({
  requireAuth: async (request: { currentUser?: { id: string; role: string } }) => {
    request.currentUser = { id: '550e8400-e29b-41d4-a716-446655440001', role: 'admin' };
  },
}));

vi.mock('../../packages/api/src/middleware/require-role', () => ({
  requireRole: () => async () => {},
}));

vi.mock('../../packages/api/src/services/audit.service', () => ({
  logAudit: logAuditMock,
}));

describe('user routes missing-target correctness', () => {
  beforeEach(() => {
    dbState.updatedRows = [];
    dbState.deletedRows = [];
    dbState.targetUserRows = [];
    dbState.adminCountRows = [{ count: 5 }];
    updateReturningMock.mockReset().mockImplementation(async () => dbState.updatedRows);
    deleteReturningMock.mockReset().mockImplementation(async () => dbState.deletedRows);
    deleteWhereMock.mockReset().mockResolvedValue(undefined);
    selectLimitMock.mockReset().mockImplementation(async () => dbState.targetUserRows);
    selectWhereNoLimitMock.mockReset().mockImplementation(async () => dbState.adminCountRows);
    executeMock.mockReset().mockResolvedValue(undefined);
    dbMock.transaction.mockClear();
    logAuditMock.mockReset();
  });

  it('returns 404 for update when the target user does not exist and logs failed audit', async () => {
    const { userRoutes } = await import('../../packages/api/src/routes/user.routes');

    const app = Fastify({ trustProxy: true });
    await app.register(fastifyCookie);
    await app.register(userRoutes);

    const response = await app.inject({
      method: 'PUT',
      url: '/api/users/550e8400-e29b-41d4-a716-446655440099',
      payload: {},
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ success: false, error: 'User not found' });
    expect(logAuditMock).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'user.update',
        target: '550e8400-e29b-41d4-a716-446655440099',
        success: false,
      })
    );
    expect(dbMock.transaction).toHaveBeenCalled();

    await app.close();
  });

  it('returns 404 for delete when the target user does not exist and logs failed audit', async () => {
    const { userRoutes } = await import('../../packages/api/src/routes/user.routes');

    const app = Fastify({ trustProxy: true });
    await app.register(fastifyCookie);
    await app.register(userRoutes);

    const response = await app.inject({
      method: 'DELETE',
      url: '/api/users/550e8400-e29b-41d4-a716-446655440099',
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ success: false, error: 'User not found' });
    expect(logAuditMock).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'user.delete',
        target: '550e8400-e29b-41d4-a716-446655440099',
        success: false,
      })
    );

    await app.close();
  });

  it('blocks demoting the last admin via PUT and logs a failed audit', async () => {
    dbState.targetUserRows = [{ id: '550e8400-e29b-41d4-a716-446655440099', role: 'admin' }];
    dbState.adminCountRows = [{ count: 0 }];
    const { userRoutes } = await import('../../packages/api/src/routes/user.routes');

    const app = Fastify({ trustProxy: true });
    await app.register(fastifyCookie);
    await app.register(userRoutes);

    const response = await app.inject({
      method: 'PUT',
      url: '/api/users/550e8400-e29b-41d4-a716-446655440099',
      payload: { role: 'readonly' },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({
      success: false,
      error: 'Cannot demote the last admin. Promote another user to admin first.',
    });
    expect(logAuditMock).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'user.update',
        target: '550e8400-e29b-41d4-a716-446655440099',
        success: false,
        details: expect.objectContaining({ reason: 'last_admin_demotion_blocked' }),
      })
    );
    expect(updateReturningMock).not.toHaveBeenCalled();

    await app.close();
  });

  it('blocks deleting the last admin via DELETE and logs a failed audit', async () => {
    dbState.targetUserRows = [{ id: '550e8400-e29b-41d4-a716-446655440099', role: 'admin' }];
    dbState.adminCountRows = [{ count: 0 }];
    const { userRoutes } = await import('../../packages/api/src/routes/user.routes');

    const app = Fastify({ trustProxy: true });
    await app.register(fastifyCookie);
    await app.register(userRoutes);

    const response = await app.inject({
      method: 'DELETE',
      url: '/api/users/550e8400-e29b-41d4-a716-446655440099',
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({
      success: false,
      error: 'Cannot delete the last admin. Promote another user to admin first.',
    });
    expect(logAuditMock).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'user.delete',
        target: '550e8400-e29b-41d4-a716-446655440099',
        success: false,
        details: expect.objectContaining({ reason: 'last_admin_deletion_blocked' }),
      })
    );
    expect(deleteReturningMock).not.toHaveBeenCalled();
    expect(dbMock.transaction).toHaveBeenCalled();

    await app.close();
  });

  it('allows demoting an admin when another admin remains', async () => {
    dbState.targetUserRows = [{ id: '550e8400-e29b-41d4-a716-446655440099', role: 'admin' }];
    dbState.adminCountRows = [{ count: 2 }];
    dbState.updatedRows = [{ id: '550e8400-e29b-41d4-a716-446655440099' }];
    const { userRoutes } = await import('../../packages/api/src/routes/user.routes');

    const app = Fastify({ trustProxy: true });
    await app.register(fastifyCookie);
    await app.register(userRoutes);

    const response = await app.inject({
      method: 'PUT',
      url: '/api/users/550e8400-e29b-41d4-a716-446655440099',
      payload: { role: 'readonly' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ success: true });
    expect(updateReturningMock).toHaveBeenCalled();

    await app.close();
  });
});
