import { beforeEach, describe, expect, it, vi } from 'vitest';

const helperClientMock = vi.hoisted(() => ({
  callHelper: vi.fn(),
}));

vi.mock('../../packages/api/src/services/helper-client', () => helperClientMock);
vi.mock('../../packages/api/src/db', () => ({
  getDb: () => ({
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => [],
        }),
      }),
    }),
    insert: () => ({
      values: async () => undefined,
    }),
  }),
  schema: {
    crashEvents: {
      id: 'id',
      pattern: 'pattern',
      summary: 'summary',
      detectedAt: 'detectedAt',
      archivedAt: 'archivedAt',
    },
  },
}));

describe('crash service scanning cursor', () => {
  beforeEach(async () => {
    helperClientMock.callHelper.mockReset();
    const { resetCrashScanCursorForTests } = await import('../../packages/api/src/services/crash.service');
    resetCrashScanCursorForTests();
  });

  it('uses the helper max line window and then advances with a since cursor', async () => {
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
});
