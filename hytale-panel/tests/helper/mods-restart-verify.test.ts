import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HelperConfig } from '../../packages/helper/src/config';

const serverControlMock = vi.hoisted(() => ({
  restartServer: vi.fn(),
}));
const logsMock = vi.hoisted(() => ({
  readLogs: vi.fn(),
}));

vi.mock('../../packages/helper/src/handlers/server-control', () => ({
  restartServer: serverControlMock.restartServer,
}));

vi.mock('../../packages/helper/src/handlers/logs', () => ({
  readLogs: logsMock.readLogs,
}));

const config = {
  socketPath: '/tmp/helper.sock',
  hmacSecret: 'x'.repeat(32),
  hytaleRoot: '/opt/hytale',
  backupPath: '/opt/hytale-backups',
  modsPath: '/opt/hytale/mods',
  disabledModsPath: '/opt/hytale/mods-disabled',
  modUploadStagingPath: '/opt/hytale-panel-data/mod-upload-staging',
  modBackupPath: '/opt/hytale/mod-backups',
  modBackupRetention: 10,
  serviceName: 'hytale-tmux.service',
  tmuxSession: 'hytale',
  tmuxSocketPath: '/opt/hytale/run/hytale.tmux.sock',
  whitelistPath: '/opt/hytale/Server/whitelist.json',
  bansPath: '/opt/hytale/Server/bans.json',
  worldsPath: '/opt/hytale/Server/worlds',
  panelUpdateJobsDir: '/opt/hytale-panel-data/update-jobs',
  panelUpdateBackupRoot: '/opt/hytale-panel-backups',
  panelUpdateRepo: 'hicham-pkg/Hytale-Server-Management-Panel',
  panelUpdateInstallEnabled: true,
  panelUpdateMaxDownloadMb: 300,
  panelUpdateBackupRetention: 5,
  hytaleUpdateEnabled: true,
  hytaleUpdateJobsDir: '/opt/hytale-panel-data/hytale-update-jobs',
  hytaleUpdatePlayerWarningSeconds: 30,
  hytaleUpdateCheckTimeoutSeconds: 60,
  hytaleUpdateDownloadTimeoutSeconds: 900,
  hytaleUpdateApplyTimeoutSeconds: 900,
} satisfies HelperConfig;

describe('mods.restartAndVerifyServer wording', () => {
  beforeEach(() => {
    vi.resetModules();
    serverControlMock.restartServer.mockReset();
    logsMock.readLogs.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('uses conservative success wording when initial log scan finds no known startup errors', async () => {
    serverControlMock.restartServer.mockResolvedValue({ success: true, message: 'Restarted' });
    logsMock.readLogs.mockResolvedValue({ success: true, lines: ['Server started'], error: undefined });

    const { restartAndVerifyServer } = await import('../../packages/helper/src/handlers/mods');
    const result = await restartAndVerifyServer(config, false);

    expect(result).toMatchObject({
      restartSucceeded: true,
      startupOk: true,
      verificationStatus: 'passed',
      message: 'Server restart completed. Initial log check found no known startup errors.',
    });
    expect(result.message).not.toMatch(/safe|compatible|common mod startup errors/i);
  });

  it('reports inconclusive verification when restart succeeds but logs cannot be scanned', async () => {
    serverControlMock.restartServer.mockResolvedValue({ success: true, message: 'Restarted' });
    logsMock.readLogs.mockResolvedValue({ success: false, lines: [], error: 'journal unavailable' });

    const { restartAndVerifyServer } = await import('../../packages/helper/src/handlers/mods');
    const result = await restartAndVerifyServer(config, true);

    expect(result).toMatchObject({
      restartSucceeded: true,
      startupOk: false,
      verificationStatus: 'inconclusive',
      rollbackPerformed: false,
      message: 'Server restarted, but startup verification was inconclusive. Check the console logs.',
    });
  });

  it('reports known startup errors clearly without claiming definitive mod safety', async () => {
    serverControlMock.restartServer.mockResolvedValue({ success: true, message: 'Restarted' });
    logsMock.readLogs.mockResolvedValue({
      success: true,
      lines: ['Error loading mod ExampleMod'],
      error: undefined,
    });

    const { restartAndVerifyServer } = await import('../../packages/helper/src/handlers/mods');
    const result = await restartAndVerifyServer(config, false);

    expect(result).toMatchObject({
      restartSucceeded: true,
      startupOk: false,
      verificationStatus: 'failed',
      rollbackPerformed: false,
      message: 'Startup verification found known startup errors. Review the detected log lines.',
      errors: ['Error loading mod ExampleMod'],
    });
    expect(result.message).not.toMatch(/safe|compatible/i);
  });
});
