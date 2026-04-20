import { beforeEach, describe, expect, it, vi } from 'vitest';

const helperClientMock = vi.hoisted(() => ({
  callHelper: vi.fn(),
}));

vi.mock('../../packages/api/src/services/helper-client', () => helperClientMock);

describe('ban service runtime/file consistency', () => {
  beforeEach(() => {
    helperClientMock.callHelper.mockReset();
  });

  it('does not fall back to file mutation when live ban command fails while server is running', async () => {
    helperClientMock.callHelper.mockResolvedValue({
      success: false,
      error: 'tmux session not found',
    });

    const { addBan } = await import('../../packages/api/src/services/ban.service');
    const result = await addBan('BadActor', 'griefing', true);

    expect(result).toEqual({
      success: false,
      message: 'Server is running; live ban command failed. File was not modified. tmux session not found',
    });
    expect(helperClientMock.callHelper).toHaveBeenCalledTimes(1);
    expect(helperClientMock.callHelper).toHaveBeenCalledWith('server.sendCommand', {
      command: 'ban BadActor griefing',
    });
  });

  it('does not fall back to file mutation when live unban command fails while server is running', async () => {
    helperClientMock.callHelper.mockResolvedValue({
      success: false,
      error: 'command rejected',
    });

    const { removeBan } = await import('../../packages/api/src/services/ban.service');
    const result = await removeBan('BadActor', true);

    expect(result).toEqual({
      success: false,
      message: 'Server is running; live unban command failed. File was not modified. command rejected',
    });
    expect(helperClientMock.callHelper).toHaveBeenCalledTimes(1);
    expect(helperClientMock.callHelper).toHaveBeenCalledWith('server.sendCommand', {
      command: 'unban BadActor',
    });
  });

  it('still performs file-based ban management when server is offline', async () => {
    helperClientMock.callHelper
      .mockResolvedValueOnce({
        success: true,
        data: { entries: [] },
      })
      .mockResolvedValueOnce({
        success: true,
      });

    const { addBan } = await import('../../packages/api/src/services/ban.service');
    const result = await addBan('OfflineUser', '', false);

    expect(result).toEqual({ success: true, message: 'Banned OfflineUser' });
    expect(helperClientMock.callHelper).toHaveBeenNthCalledWith(1, 'bans.read');
    expect(helperClientMock.callHelper).toHaveBeenNthCalledWith(
      2,
      'bans.write',
      expect.objectContaining({
        entries: [
          expect.objectContaining({
            name: 'OfflineUser',
            reason: '',
          }),
        ],
      })
    );
  });
});
