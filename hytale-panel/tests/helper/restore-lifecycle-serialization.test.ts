import { beforeEach, describe, expect, it, vi } from 'vitest';

const commandMock = vi.hoisted(() => ({
  runAllowlistedCommand: vi.fn(),
  safeExec: vi.fn(),
}));

const tmuxMock = vi.hoisted(() => ({
  tmuxExec: vi.fn(),
}));

const pathGuardMock = vi.hoisted(() => ({
  guardPath: vi.fn(),
}));

const fsMock = vi.hoisted(() => ({
  access: vi.fn(),
  mkdir: vi.fn(),
  writeFile: vi.fn(),
  rename: vi.fn(),
}));

vi.mock('../../packages/helper/src/utils/command', () => commandMock);
vi.mock('../../packages/helper/src/utils/tmux', () => tmuxMock);
vi.mock('../../packages/helper/src/utils/path-guard', () => pathGuardMock);
vi.mock('fs/promises', () => fsMock);

const helperConfig = {
  socketPath: '/opt/hytale-panel/run/hytale-helper.sock',
  hmacSecret: 'x'.repeat(32),
  hytaleRoot: '/opt/hytale',
  backupPath: '/opt/hytale-backups',
  serviceName: 'hytale-tmux.service',
  tmuxSession: 'hytale',
  tmuxSocketPath: '/opt/hytale/run/hytale.tmux.sock',
  whitelistPath: '/opt/hytale/Server/whitelist.json',
  bansPath: '/opt/hytale/Server/bans.json',
  worldsPath: '/opt/hytale/Server/worlds',
};

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('helper restore/lifecycle serialization', () => {
  beforeEach(() => {
    vi.resetModules();
    commandMock.runAllowlistedCommand.mockReset();
    commandMock.safeExec.mockReset();
    tmuxMock.tmuxExec.mockReset();
    pathGuardMock.guardPath.mockReset();
    fsMock.access.mockReset();
    fsMock.mkdir.mockReset();
    fsMock.writeFile.mockReset();
    fsMock.rename.mockReset();
    fsMock.mkdir.mockResolvedValue(undefined);
    fsMock.writeFile.mockResolvedValue(undefined);
    fsMock.rename.mockResolvedValue(undefined);
  });

  it('queues lifecycle operations behind an in-flight restore operation', async () => {
    const statusResult = {
      stdout: '',
      stderr: 'Unit hytale-tmux.service could not be found.',
      exitCode: 3,
    };
    commandMock.runAllowlistedCommand.mockResolvedValue(statusResult);
    tmuxMock.tmuxExec.mockResolvedValue({ stdout: '', stderr: 'no session', exitCode: 1 });
    pathGuardMock.guardPath.mockImplementation(async (inputPath: string) => inputPath);

    const accessGate = deferred<void>();
    fsMock.access.mockImplementation(() => accessGate.promise);

    const { restoreBackup } = await import('../../packages/helper/src/handlers/backup');
    const { stopServer } = await import('../../packages/helper/src/handlers/server-control');

    const restorePromise = restoreBackup(helperConfig, 'backup.tar.gz');
    await vi.waitFor(() => {
      expect(commandMock.runAllowlistedCommand).toHaveBeenCalledTimes(1);
    });

    const stopPromise = stopServer(helperConfig);
    await Promise.resolve();
    await Promise.resolve();

    // stopServer must remain queued until restoreBackup releases the shared lock
    expect(commandMock.runAllowlistedCommand).toHaveBeenCalledTimes(1);

    accessGate.reject(Object.assign(new Error('missing backup'), { code: 'ENOENT' }));

    await expect(restorePromise).resolves.toMatchObject({
      success: false,
      error: 'Backup file not found',
      operationId: expect.any(String),
    });

    await expect(stopPromise).resolves.toEqual({
      success: true,
      message: 'Server is already stopped',
    });
    expect(commandMock.runAllowlistedCommand).toHaveBeenCalledTimes(2);
  });
});
