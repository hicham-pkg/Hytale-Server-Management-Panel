import { beforeEach, describe, expect, it, vi } from 'vitest';

const helperClientMock = vi.hoisted(() => ({
  callHelper: vi.fn(),
}));

const dbState = vi.hoisted(() => ({
  rows: [] as Array<{
    id: string;
    filename: string;
    label: string | null;
    sizeBytes: number;
    sha256: string;
    createdBy: string | null;
    createdAt: Date;
  }>,
  insertedRows: [] as Array<Record<string, unknown>>,
}));

vi.mock('../../packages/api/src/services/helper-client', () => helperClientMock);

vi.mock('../../packages/api/src/db', () => ({
  getDb: () => ({
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => dbState.rows,
          then: (resolve: (value: typeof dbState.rows) => unknown) => Promise.resolve(resolve(dbState.rows)),
        }),
        orderBy: async () => dbState.rows,
        limit: async () => dbState.rows,
      }),
    }),
    insert: () => ({
      values: async (row: Record<string, unknown>) => {
        dbState.insertedRows.push(row);
      },
    }),
  }),
  schema: {
    backupMetadata: {
      id: 'id',
      filename: 'filename',
      createdAt: 'createdAt',
    },
  },
}));

vi.mock('drizzle-orm', () => ({
  desc: (value: unknown) => value,
  eq: () => ({}),
  inArray: () => ({}),
}));

describe('Backup service helper contract', () => {
  beforeEach(() => {
    helperClientMock.callHelper.mockReset();
    dbState.rows = [];
    dbState.insertedRows = [];
  });

  it('accepts the helper backup.list payload shaped as { data: { backups: [...] } }', async () => {
    helperClientMock.callHelper.mockResolvedValue({
      success: true,
      data: {
        backups: [
          {
            filename: '2026-03-25T10-00-00-000Z_world.tar.gz',
            sizeBytes: 1234,
            createdAt: '2026-03-25T10:00:00.000Z',
          },
        ],
      },
    });

    dbState.rows = [
      {
        id: '550e8400-e29b-41d4-a716-446655440000',
        filename: '2026-03-25T10-00-00-000Z_world.tar.gz',
        label: 'nightly',
        sizeBytes: 9999,
        sha256: 'abc123',
        createdBy: '550e8400-e29b-41d4-a716-446655440001',
        createdAt: new Date('2026-03-25T09:59:00.000Z'),
      },
    ];

    const { listBackups } = await import('../../packages/api/src/services/backup.service');
    const result = await listBackups();

    expect(result).toEqual({
      helperOffline: false,
      backups: [
        {
          id: '550e8400-e29b-41d4-a716-446655440000',
          filename: '2026-03-25T10-00-00-000Z_world.tar.gz',
          label: 'nightly',
          sizeBytes: 1234,
          sha256: 'abc123',
          createdBy: '550e8400-e29b-41d4-a716-446655440001',
          createdAt: '2026-03-25T10:00:00.000Z',
        },
      ],
    });
  });

  it('remains backward-compatible with a legacy array payload', async () => {
    helperClientMock.callHelper.mockResolvedValue({
      success: true,
      data: [
        {
          filename: '2026-03-24T10-00-00-000Z_world.tar.gz',
          sizeBytes: 4321,
          createdAt: '2026-03-24T10:00:00.000Z',
        },
      ],
    });

    const { listBackups } = await import('../../packages/api/src/services/backup.service');
    const result = await listBackups();

    expect(result).toEqual({
      helperOffline: false,
      backups: [
        {
          id: '2026-03-24T10-00-00-000Z_world.tar.gz',
          filename: '2026-03-24T10-00-00-000Z_world.tar.gz',
          label: null,
          sizeBytes: 4321,
          sha256: '',
          createdBy: null,
          createdAt: '2026-03-24T10:00:00.000Z',
        },
      ],
    });
  });

  it('falls back to DB metadata when helper transport fails during backup.list', async () => {
    helperClientMock.callHelper.mockRejectedValue(new Error('socket hang up'));
    dbState.rows = [
      {
        id: '550e8400-e29b-41d4-a716-446655440000',
        filename: '2026-03-25T10-00-00-000Z_world.tar.gz',
        label: 'nightly',
        sizeBytes: 1234,
        sha256: 'abc123',
        createdBy: '550e8400-e29b-41d4-a716-446655440001',
        createdAt: new Date('2026-03-25T10:00:00.000Z'),
      },
    ];

    const { listBackups } = await import('../../packages/api/src/services/backup.service');
    const result = await listBackups();

    expect(result).toEqual({
      helperOffline: true,
      backups: [
        {
          id: '550e8400-e29b-41d4-a716-446655440000',
          filename: '2026-03-25T10-00-00-000Z_world.tar.gz',
          label: 'nightly',
          sizeBytes: 1234,
          sha256: 'abc123',
          createdBy: '550e8400-e29b-41d4-a716-446655440001',
          createdAt: '2026-03-25T10:00:00.000Z',
          helperOffline: true,
        },
      ],
    });
  });

  it('uses an extended helper timeout for backup.create to match long-running tar operations', async () => {
    helperClientMock.callHelper.mockResolvedValue({
      success: true,
      data: {
        id: '550e8400-e29b-41d4-a716-446655440000',
        filename: '2026-03-24T10-00-00-000Z_world.tar.gz',
        sizeBytes: 4321,
        sha256: 'abc123',
        createdAt: '2026-03-24T10:00:00.000Z',
      },
    });

    const { createBackup } = await import('../../packages/api/src/services/backup.service');
    const result = await createBackup('nightly', '550e8400-e29b-41d4-a716-446655440001');

    expect(result.success).toBe(true);
    expect(helperClientMock.callHelper).toHaveBeenCalledWith(
      'backup.create',
      { label: 'nightly' },
      { timeoutMs: 360000 }
    );
    expect(dbState.insertedRows).toHaveLength(1);
  });

  it('forwards operationId to helper backup.create when provided', async () => {
    helperClientMock.callHelper.mockResolvedValue({
      success: true,
      data: {
        id: '550e8400-e29b-41d4-a716-446655440010',
        filename: '2026-03-26T10-00-00-000Z_world.tar.gz',
        sizeBytes: 4321,
        sha256: 'def456',
        createdAt: '2026-03-26T10:00:00.000Z',
      },
    });

    const { createBackup } = await import('../../packages/api/src/services/backup.service');
    const result = await createBackup(
      'nightly',
      '550e8400-e29b-41d4-a716-446655440001',
      '550e8400-e29b-41d4-a716-446655440099'
    );

    expect(result.success).toBe(true);
    expect(helperClientMock.callHelper).toHaveBeenCalledWith(
      'backup.create',
      {
        label: 'nightly',
        operationId: '550e8400-e29b-41d4-a716-446655440099',
      },
      { timeoutMs: 360000 }
    );
  });

  it('uses extended helper timeouts for backup.hash and backup.restore', async () => {
    dbState.rows = [
      {
        id: '550e8400-e29b-41d4-a716-446655440000',
        filename: '2026-03-24T10-00-00-000Z_world.tar.gz',
        label: 'nightly',
        sizeBytes: 4321,
        sha256: 'abc123',
        createdBy: '550e8400-e29b-41d4-a716-446655440001',
        createdAt: new Date('2026-03-24T10:00:00.000Z'),
      },
    ];

    helperClientMock.callHelper
      .mockResolvedValueOnce({ success: true, data: { sha256: 'abc123' } })
      .mockResolvedValueOnce({ success: true, data: { safetyBackup: 'safety-pre-restore.tar.gz' } });

    const { restoreBackup } = await import('../../packages/api/src/services/backup.service');
    const result = await restoreBackup('550e8400-e29b-41d4-a716-446655440000');

    expect(result).toEqual({ success: true, safetyBackup: 'safety-pre-restore.tar.gz' });
    expect(helperClientMock.callHelper).toHaveBeenNthCalledWith(
      1,
      'backup.hash',
      { filename: '2026-03-24T10-00-00-000Z_world.tar.gz' },
      { timeoutMs: 360000 }
    );
    expect(helperClientMock.callHelper).toHaveBeenNthCalledWith(
      2,
      'backup.restore',
      { filename: '2026-03-24T10-00-00-000Z_world.tar.gz' },
      { timeoutMs: 720000 }
    );
  });

  it('maps helper backup operation state responses for job reconciliation', async () => {
    helperClientMock.callHelper.mockResolvedValue({
      success: true,
      data: {
        found: true,
        operation: {
          status: 'succeeded',
          result: {
            safetyBackup: 'safety-pre-restore.tar.gz',
          },
        },
      },
    });

    const { getBackupOperationStatus } = await import('../../packages/api/src/services/backup.service');
    const result = await getBackupOperationStatus('550e8400-e29b-41d4-a716-446655440099');

    expect(result).toEqual({
      success: true,
      found: true,
      status: 'succeeded',
      resultPayload: {
        safetyBackup: 'safety-pre-restore.tar.gz',
      },
      error: undefined,
    });
    expect(helperClientMock.callHelper).toHaveBeenCalledWith(
      'backup.operationStatus',
      { operationId: '550e8400-e29b-41d4-a716-446655440099' }
    );
  });

  it('maps helper unknown operation state and phase for conservative reconciliation', async () => {
    helperClientMock.callHelper.mockResolvedValue({
      success: true,
      data: {
        found: true,
        operation: {
          status: 'unknown',
          phase: 'unknown',
          error: 'Restore outcome unknown after helper restart',
        },
      },
    });

    const { getBackupOperationStatus } = await import('../../packages/api/src/services/backup.service');
    const result = await getBackupOperationStatus('550e8400-e29b-41d4-a716-446655440098');

    expect(result).toEqual({
      success: true,
      found: true,
      status: 'unknown',
      phase: 'unknown',
      resultPayload: null,
      error: 'Restore outcome unknown after helper restart',
    });
  });
});
