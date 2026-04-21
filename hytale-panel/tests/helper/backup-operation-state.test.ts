import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const commandMock = vi.hoisted(() => ({
  safeExec: vi.fn(),
}));

vi.mock('../../packages/helper/src/utils/command', () => ({
  safeExec: commandMock.safeExec,
}));

describe('helper backup operation durable state', () => {
  const operationStateDirName = '.panel-operations';
  const restoreMarkerDirName = 'restore-completions';

  let rootDir: string;
  let helperConfig: {
    socketPath: string;
    hmacSecret: string;
    hytaleRoot: string;
    backupPath: string;
    serviceName: string;
    tmuxSession: string;
    tmuxSocketPath: string;
    whitelistPath: string;
    bansPath: string;
    worldsPath: string;
  };

  beforeEach(async () => {
    vi.resetModules();
    commandMock.safeExec.mockReset();

    rootDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'hytale-helper-op-')));
    const backupPath = path.join(rootDir, 'backups');
    const worldsPath = path.join(rootDir, 'Server', 'worlds');

    await fs.mkdir(backupPath, { recursive: true });
    await fs.mkdir(worldsPath, { recursive: true });
    await fs.writeFile(path.join(worldsPath, 'level.dat'), 'dummy-world-data');

    helperConfig = {
      socketPath: path.join(rootDir, 'hytale-helper.sock'),
      hmacSecret: 'x'.repeat(32),
      hytaleRoot: rootDir,
      backupPath,
      serviceName: 'hytale-tmux.service',
      tmuxSession: 'hytale',
      tmuxSocketPath: path.join(rootDir, 'hytale.tmux.sock'),
      whitelistPath: path.join(rootDir, 'Server', 'whitelist.json'),
      bansPath: path.join(rootDir, 'Server', 'bans.json'),
      worldsPath,
    };
  });

  afterEach(async () => {
    await fs.rm(rootDir, { recursive: true, force: true });
  });

  function operationStatePath(operationId: string): string {
    return path.join(helperConfig.backupPath, operationStateDirName, `${operationId}.json`);
  }

  function restoreMarkerPath(operationId: string): string {
    return path.join(helperConfig.backupPath, operationStateDirName, restoreMarkerDirName, `${operationId}.json`);
  }

  it('persists succeeded helper operation state durably on disk', async () => {
    commandMock.safeExec.mockImplementation(async (_binary: string, args: string[]) => {
      if (args[0] === '-czf') {
        await fs.writeFile(args[1], 'fake-tar-content');
      }
      return { stdout: '', stderr: '', exitCode: 0 };
    });

    const operationId = '550e8400-e29b-41d4-a716-446655440001';
    const { createBackup, getBackupOperationStatus } = await import('../../packages/helper/src/handlers/backup');

    const createResult = await createBackup(helperConfig, 'nightly', operationId);
    expect(createResult.success).toBe(true);

    const status = await getBackupOperationStatus(helperConfig, operationId);
    expect(status).toMatchObject({
      success: true,
      found: true,
      operation: {
        id: operationId,
        type: 'create',
        status: 'succeeded',
      },
    });

    vi.resetModules();
    const { getBackupOperationStatus: readAfterReload } = await import('../../packages/helper/src/handlers/backup');
    const afterReload = await readAfterReload(helperConfig, operationId);
    expect(afterReload).toMatchObject({
      success: true,
      found: true,
      operation: {
        id: operationId,
        status: 'succeeded',
      },
    });
  });

  it('persists failed helper operation state durably on disk', async () => {
    const missingWorldsConfig = {
      ...helperConfig,
      worldsPath: path.join(rootDir, 'Server', 'missing-worlds'),
    };

    const operationId = '550e8400-e29b-41d4-a716-446655440002';
    const { createBackup, getBackupOperationStatus } = await import('../../packages/helper/src/handlers/backup');

    const createResult = await createBackup(missingWorldsConfig, 'nightly', operationId);
    expect(createResult.success).toBe(false);

    const status = await getBackupOperationStatus(missingWorldsConfig, operationId);
    expect(status).toMatchObject({
      success: true,
      found: true,
      operation: {
        id: operationId,
        type: 'create',
        status: 'failed',
      },
    });
  });

  it('reconciles stale running create state to succeeded on operationStatus lookup', async () => {
    commandMock.safeExec.mockResolvedValue({
      stdout: 'worlds/\nworlds/level.dat\n',
      stderr: '',
      exitCode: 0,
    });

    const operationId = '550e8400-e29b-41d4-a716-446655440003';
    const backupFilename = '2026-04-21T08-00-00-000Z_nightly.tar.gz';
    await fs.writeFile(path.join(helperConfig.backupPath, backupFilename), 'fake-tar-content');
    await fs.mkdir(path.dirname(operationStatePath(operationId)), { recursive: true });
    await fs.writeFile(
      operationStatePath(operationId),
      JSON.stringify({
        id: operationId,
        type: 'create',
        status: 'running',
        phase: 'archiving',
        startedAt: '2026-04-21T08:00:00.000Z',
        updatedAt: '2026-04-21T08:01:00.000Z',
        targetFilename: backupFilename,
        backupId: '550e8400-e29b-41d4-a716-4466554400aa',
        helperInstanceId: 'old-helper-instance',
        pid: 12345,
      })
    );

    const { getBackupOperationStatus } = await import('../../packages/helper/src/handlers/backup');
    const status = await getBackupOperationStatus(helperConfig, operationId);
    expect(status).toMatchObject({
      success: true,
      found: true,
      operation: {
        id: operationId,
        type: 'create',
        status: 'succeeded',
        phase: 'recovered',
      },
    });

    const persisted = JSON.parse(await fs.readFile(operationStatePath(operationId), 'utf8'));
    expect(persisted.status).toBe('succeeded');
    expect(persisted.result?.backup?.filename).toBe(backupFilename);
  });

  it('reconciles stale running create state to failed when output archive is missing', async () => {
    const operationId = '550e8400-e29b-41d4-a716-446655440004';
    await fs.mkdir(path.dirname(operationStatePath(operationId)), { recursive: true });
    await fs.writeFile(
      operationStatePath(operationId),
      JSON.stringify({
        id: operationId,
        type: 'create',
        status: 'running',
        phase: 'archiving',
        startedAt: '2026-04-21T08:00:00.000Z',
        updatedAt: '2026-04-21T08:01:00.000Z',
        targetFilename: '2026-04-21T08-00-00-000Z_missing.tar.gz',
        backupId: '550e8400-e29b-41d4-a716-4466554400ab',
        helperInstanceId: 'old-helper-instance',
        pid: 12345,
      })
    );

    const { getBackupOperationStatus } = await import('../../packages/helper/src/handlers/backup');
    const status = await getBackupOperationStatus(helperConfig, operationId);
    expect(status).toMatchObject({
      success: true,
      found: true,
      operation: {
        id: operationId,
        type: 'create',
        status: 'failed',
      },
    });
  });

  it('reconciles stale running restore state to succeeded when completion marker exists', async () => {
    const operationId = '550e8400-e29b-41d4-a716-446655440005';
    await fs.mkdir(path.dirname(operationStatePath(operationId)), { recursive: true });
    await fs.writeFile(
      operationStatePath(operationId),
      JSON.stringify({
        id: operationId,
        type: 'restore',
        status: 'running',
        phase: 'extracting',
        startedAt: '2026-04-21T08:00:00.000Z',
        updatedAt: '2026-04-21T08:01:00.000Z',
        restoreSourceFilename: 'worlds-backup.tar.gz',
        helperInstanceId: 'old-helper-instance',
        pid: 12345,
      })
    );

    await fs.mkdir(path.dirname(restoreMarkerPath(operationId)), { recursive: true });
    await fs.writeFile(
      restoreMarkerPath(operationId),
      JSON.stringify({
        operationId,
        sourceFilename: 'worlds-backup.tar.gz',
        safetyBackup: 'safety-pre-restore.tar.gz',
        completedAt: '2026-04-21T08:02:00.000Z',
        helperInstanceId: 'old-helper-instance',
      })
    );

    const { getBackupOperationStatus } = await import('../../packages/helper/src/handlers/backup');
    const status = await getBackupOperationStatus(helperConfig, operationId);
    expect(status).toMatchObject({
      success: true,
      found: true,
      operation: {
        id: operationId,
        type: 'restore',
        status: 'succeeded',
        phase: 'recovered',
        result: {
          safetyBackup: 'safety-pre-restore.tar.gz',
        },
      },
    });
  });

  it('marks stale running restore state as unknown when completion marker is missing', async () => {
    const operationId = '550e8400-e29b-41d4-a716-446655440006';
    await fs.mkdir(path.dirname(operationStatePath(operationId)), { recursive: true });
    await fs.writeFile(
      operationStatePath(operationId),
      JSON.stringify({
        id: operationId,
        type: 'restore',
        status: 'running',
        phase: 'extracting',
        startedAt: '2026-04-21T08:00:00.000Z',
        updatedAt: '2026-04-21T08:01:00.000Z',
        restoreSourceFilename: 'worlds-backup.tar.gz',
        helperInstanceId: 'old-helper-instance',
        pid: 12345,
      })
    );

    const { getBackupOperationStatus } = await import('../../packages/helper/src/handlers/backup');
    const status = await getBackupOperationStatus(helperConfig, operationId);
    expect(status).toMatchObject({
      success: true,
      found: true,
      operation: {
        id: operationId,
        type: 'restore',
        status: 'unknown',
      },
    });
    expect(status.operation?.error).toContain('completion marker missing');
  });

  it('does not leave temporary state files after durable operation writes', async () => {
    commandMock.safeExec.mockImplementation(async (_binary: string, args: string[]) => {
      if (args[0] === '-czf') {
        await fs.writeFile(args[1], 'fake-tar-content');
      }
      return { stdout: '', stderr: '', exitCode: 0 };
    });

    const operationId = '550e8400-e29b-41d4-a716-446655440007';
    const { createBackup } = await import('../../packages/helper/src/handlers/backup');
    const result = await createBackup(helperConfig, 'nightly', operationId);
    expect(result.success).toBe(true);

    const stateDir = path.join(helperConfig.backupPath, operationStateDirName);
    const entries = await fs.readdir(stateDir);
    expect(entries.some((entry) => entry.endsWith('.tmp'))).toBe(false);
    expect(entries).toContain(`${operationId}.json`);
  });
});
