import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const execMock = vi.hoisted(() => ({ fn: vi.fn() }));
vi.mock('node:child_process', async () => {
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
  return {
    ...actual,
    execFile: (cmd: string, args: string[], opts: unknown, cb?: (err: Error | null, stdout: string, stderr: string) => void) => {
      const callback = typeof opts === 'function' ? (opts as typeof cb) : cb;
      const handled = execMock.fn(cmd, args, opts, callback);
      if (handled === true) return;
      if (callback) callback(null, '', '');
    },
  };
});

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'hytale-update-handler-'));
const JOBS_DIR = path.join(ROOT, 'hytale-update-jobs');

function makeConfig(overrides: Partial<Record<string, unknown>> = {}): any {
  return {
    socketPath: '/tmp/x.sock',
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
    panelUpdateJobsDir: path.join(ROOT, 'panel-update-jobs'),
    panelUpdateBackupRoot: path.join(ROOT, 'panel-backups'),
    panelUpdateRepo: 'hicham-pkg/Hytale-Server-Management-Panel',
    panelUpdateInstallEnabled: true,
    panelUpdateMaxDownloadMb: 300,
    panelUpdateBackupRetention: 5,
    hytaleUpdateEnabled: true,
    hytaleUpdateJobsDir: JOBS_DIR,
    hytaleUpdatePlayerWarningSeconds: 30,
    hytaleUpdateCheckTimeoutSeconds: 60,
    hytaleUpdateDownloadTimeoutSeconds: 900,
    hytaleUpdateApplyTimeoutSeconds: 900,
    ...overrides,
  };
}

beforeEach(() => {
  vi.resetModules();
  execMock.fn.mockReset();
  fs.rmSync(JOBS_DIR, { recursive: true, force: true });
  fs.mkdirSync(JOBS_DIR, { recursive: true });
});

describe('hytaleUpdateStart', () => {
  it('rejects when disabled', async () => {
    const { hytaleUpdateStart } = await import('../../packages/helper/src/handlers/hytale-update');
    const result = await hytaleUpdateStart(makeConfig({ hytaleUpdateEnabled: false }), 'check');
    expect(result.success).toBe(false);
    expect(execMock.fn).not.toHaveBeenCalled();
  });

  it('creates durable job files and starts the validating wrapper', async () => {
    const { hytaleUpdateStart } = await import('../../packages/helper/src/handlers/hytale-update');
    const result = await hytaleUpdateStart(makeConfig(), 'update-now');
    expect(result.success).toBe(true);
    expect(result.jobId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    const jobDir = path.join(JOBS_DIR, result.jobId!);
    const spec = JSON.parse(fs.readFileSync(path.join(jobDir, 'spec.json'), 'utf8')) as Record<string, unknown>;
    const status = JSON.parse(fs.readFileSync(path.join(jobDir, 'status.json'), 'utf8')) as Record<string, unknown>;
    expect(spec).toMatchObject({ kind: 'hytale-update', action: 'update-now', jobId: result.jobId });
    expect(status).toMatchObject({ kind: 'hytale-update', action: 'update-now', status: 'running' });

    expect(execMock.fn).toHaveBeenCalledTimes(1);
    const [cmd, args] = execMock.fn.mock.calls[0] as [string, string[]];
    expect(cmd).toBe('/usr/bin/sudo');
    expect(args).toEqual(['-n', '/usr/local/lib/hytale-panel/hytale-server-updater-trigger', 'start', result.jobId]);
  });

  it('prevents concurrent running update jobs', async () => {
    const { hytaleUpdateStart } = await import('../../packages/helper/src/handlers/hytale-update');
    const first = await hytaleUpdateStart(makeConfig(), 'check');
    expect(first.success).toBe(true);
    const second = await hytaleUpdateStart(makeConfig(), 'download');
    expect(second.success).toBe(false);
    expect(second.error).toMatch(/already running/);
  });
});
