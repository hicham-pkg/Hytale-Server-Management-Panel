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
}));

vi.mock('../../packages/api/src/services/helper-client', () => helperClientMock);

vi.mock('../../packages/api/src/db', () => ({
  getDb: () => ({
    select: () => ({
      from: () => ({
        where: async () => dbState.rows,
        orderBy: async () => dbState.rows,
        limit: async () => dbState.rows,
      }),
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
    const backups = await listBackups();

    expect(backups).toEqual([
      {
        id: '550e8400-e29b-41d4-a716-446655440000',
        filename: '2026-03-25T10-00-00-000Z_world.tar.gz',
        label: 'nightly',
        sizeBytes: 1234,
        sha256: 'abc123',
        createdBy: '550e8400-e29b-41d4-a716-446655440001',
        createdAt: '2026-03-25T10:00:00.000Z',
      },
    ]);
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
    const backups = await listBackups();

    expect(backups).toEqual([
      {
        id: '2026-03-24T10-00-00-000Z_world.tar.gz',
        filename: '2026-03-24T10-00-00-000Z_world.tar.gz',
        label: null,
        sizeBytes: 4321,
        sha256: '',
        createdBy: null,
        createdAt: '2026-03-24T10:00:00.000Z',
      },
    ]);
  });
});
