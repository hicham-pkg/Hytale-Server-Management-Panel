import { beforeEach, describe, expect, it, vi } from 'vitest';

const helperClientMock = vi.hoisted(() => ({
  callHelper: vi.fn(),
}));

const schemaMock = vi.hoisted(() => ({
  crashEvents: {
    id: 'id',
    pattern: 'pattern',
    summary: 'summary',
    detectedAt: 'detectedAt',
    archivedAt: 'archivedAt',
  },
  crashScanState: {
    id: 'id',
    cursorSince: 'cursorSince',
    lastScannedAt: 'lastScannedAt',
    lastLineCount: 'lastLineCount',
    updatedAt: 'updatedAt',
  },
}));

const dbState = vi.hoisted(() => ({
  crashScanState: null as null | {
    id: number;
    cursorSince: unknown;
    lastScannedAt: Date | null;
    lastLineCount: number;
    updatedAt: Date;
  },
  crashEvents: [] as Array<Record<string, unknown>>,
  lockHeld: false,
  lockAttempts: 0,
  lockAcquired: 0,
  lockReleased: 0,
  connectionsReleased: 0,
}));

function resetDbState(): void {
  dbState.crashScanState = null;
  dbState.crashEvents = [];
  dbState.lockHeld = false;
  dbState.lockAttempts = 0;
  dbState.lockAcquired = 0;
  dbState.lockReleased = 0;
  dbState.connectionsReleased = 0;
}

vi.mock('../../packages/api/src/services/helper-client', () => helperClientMock);

vi.mock('../../packages/api/src/db', () => ({
  getDb: () => ({
    select: (projection?: Record<string, unknown>) => ({
      from: (table: unknown) => ({
        where: () => ({
          limit: async () => {
            if (table === schemaMock.crashScanState) {
              if (!dbState.crashScanState) {
                return [];
              }
              if (projection && 'id' in projection) {
                return [{ id: dbState.crashScanState.id }];
              }
              return [dbState.crashScanState];
            }
            if (table === schemaMock.crashEvents) {
              return [];
            }
            return [];
          },
        }),
      }),
    }),
    insert: (table: unknown) => ({
      values: async (values: Record<string, unknown>) => {
        if (table === schemaMock.crashScanState) {
          dbState.crashScanState = {
            id: Number(values.id ?? 1),
            cursorSince: values.cursorSince ?? null,
            lastScannedAt: (values.lastScannedAt as Date | null) ?? null,
            lastLineCount: Number(values.lastLineCount ?? 0),
            updatedAt: (values.updatedAt as Date) ?? new Date(),
          };
          return;
        }
        if (table === schemaMock.crashEvents) {
          dbState.crashEvents.push(values);
        }
      },
    }),
    update: (table: unknown) => ({
      set: (values: Record<string, unknown>) => ({
        where: async () => {
          if (table !== schemaMock.crashScanState) {
            return;
          }
          const current = dbState.crashScanState ?? {
            id: 1,
            cursorSince: null,
            lastScannedAt: null,
            lastLineCount: 0,
            updatedAt: new Date(0),
          };
          dbState.crashScanState = {
            ...current,
            ...values,
          };
        },
      }),
    }),
  }),
  getPool: () => ({
    connect: async () => ({
      query: async (query: string) => {
        if (query.includes('pg_try_advisory_lock')) {
          dbState.lockAttempts += 1;
          if (dbState.lockHeld) {
            return { rows: [{ locked: false }] };
          }
          dbState.lockHeld = true;
          dbState.lockAcquired += 1;
          return { rows: [{ locked: true }] };
        }
        if (query.includes('pg_advisory_unlock')) {
          if (dbState.lockHeld) {
            dbState.lockHeld = false;
            dbState.lockReleased += 1;
          }
          return { rows: [] };
        }
        return { rows: [] };
      },
      release: () => {
        dbState.connectionsReleased += 1;
      },
    }),
  }),
  schema: schemaMock,
}));

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('crash service durable scan cursor', () => {
  beforeEach(() => {
    vi.resetModules();
    helperClientMock.callHelper.mockReset();
    resetDbState();
  });

  it('initializes safely with no persisted cursor and writes scan state metadata', async () => {
    helperClientMock.callHelper.mockResolvedValue({
      success: true,
      data: {
        lines: [
          '2026-03-29T12:00:00 Started Hytale',
          '2026-03-29T12:00:30 Tick loop healthy',
        ],
      },
    });

    const { scanForCrashes } = await import('../../packages/api/src/services/crash.service');
    await scanForCrashes();

    expect(helperClientMock.callHelper).toHaveBeenCalledWith('logs.read', { lines: 1000 });
    expect(dbState.crashScanState).not.toBeNull();
    expect(dbState.crashScanState?.lastLineCount).toBe(2);
    expect(dbState.crashScanState?.cursorSince).toBeInstanceOf(Date);
  });

  it('uses the helper max line window and then advances with a persisted since cursor', async () => {
    helperClientMock.callHelper
      .mockResolvedValueOnce({
        success: true,
        data: {
          lines: [
            '2026-03-29T12:00:00 Started Hytale',
            '2026-03-29T12:00:30 Tick loop healthy',
          ],
        },
      })
      .mockResolvedValueOnce({
        success: true,
        data: {
          lines: [
            '2026-03-29T12:01:00 Tick loop healthy',
          ],
        },
      });

    const { scanForCrashes } = await import('../../packages/api/src/services/crash.service');
    await scanForCrashes();
    await scanForCrashes();

    expect(helperClientMock.callHelper).toHaveBeenNthCalledWith(1, 'logs.read', { lines: 1000 });
    expect(helperClientMock.callHelper).toHaveBeenNthCalledWith(
      2,
      'logs.read',
      expect.objectContaining({
        lines: 1000,
        since: expect.any(String),
      })
    );
  });

  it('persists cursor across module reload style scenarios', async () => {
    helperClientMock.callHelper
      .mockResolvedValueOnce({
        success: true,
        data: {
          lines: ['2026-03-29T12:00:30 Tick loop healthy'],
        },
      })
      .mockResolvedValueOnce({
        success: true,
        data: {
          lines: ['2026-03-29T12:01:00 Tick loop healthy'],
        },
      });

    const { scanForCrashes } = await import('../../packages/api/src/services/crash.service');
    await scanForCrashes();
    const persistedSince = (dbState.crashScanState?.cursorSince as Date).toISOString();

    vi.resetModules();

    const { scanForCrashes: scanAfterReload } = await import('../../packages/api/src/services/crash.service');
    await scanAfterReload();

    expect(helperClientMock.callHelper).toHaveBeenNthCalledWith(2, 'logs.read', {
      lines: 1000,
      since: persistedSince,
    });
  });

  it('falls back safely when persisted cursor is invalid', async () => {
    dbState.crashScanState = {
      id: 1,
      cursorSince: 'not-a-date',
      lastScannedAt: new Date('2026-03-29T11:59:00.000Z'),
      lastLineCount: 9,
      updatedAt: new Date('2026-03-29T11:59:00.000Z'),
    };

    helperClientMock.callHelper.mockResolvedValue({
      success: true,
      data: {
        lines: ['2026-03-29T12:02:00 Tick loop healthy'],
      },
    });

    const { scanForCrashes } = await import('../../packages/api/src/services/crash.service');
    await scanForCrashes();

    expect(helperClientMock.callHelper).toHaveBeenCalledWith('logs.read', { lines: 1000 });
    expect(dbState.crashScanState?.cursorSince).toBeInstanceOf(Date);
  });

  it('prevents overlapping scans from both executing when advisory lock is already held', async () => {
    const gate = deferred<{ success: boolean; data: { lines: string[] } }>();
    helperClientMock.callHelper.mockImplementationOnce(() => gate.promise);

    const { scanForCrashes } = await import('../../packages/api/src/services/crash.service');

    const firstScan = scanForCrashes();
    await Promise.resolve();

    const secondScan = scanForCrashes();
    await expect(secondScan).resolves.toBe(0);
    expect(helperClientMock.callHelper).toHaveBeenCalledTimes(1);
    expect(dbState.lockAttempts).toBe(2);
    expect(dbState.lockAcquired).toBe(1);

    gate.resolve({
      success: true,
      data: { lines: ['2026-03-29T12:03:00 Tick loop healthy'] },
    });

    await expect(firstScan).resolves.toBe(0);
    expect(dbState.lockReleased).toBe(1);
    expect(dbState.crashScanState?.lastLineCount).toBe(1);
  });
});
