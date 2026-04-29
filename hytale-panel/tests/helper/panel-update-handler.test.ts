import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const ORIGINAL_ENV = { ...process.env };

const execMock = vi.hoisted(() => ({
  fn: vi.fn(),
}));

vi.mock('node:child_process', async () => {
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
  return {
    ...actual,
    // Promisified execFile inside the handler — return a function that
    // matches Node's signature and forwards to our mock.
    execFile: (cmd: string, args: string[], opts: unknown, cb?: (err: Error | null, stdout: string, stderr: string) => void) => {
      const callback = typeof opts === 'function' ? (opts as typeof cb) : cb;
      execMock.fn(cmd, args, opts);
      // Default success unless the mock has been preconfigured to throw.
      if (callback) callback(null, '', '');
    },
  };
});

const ROOT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'hytale-panel-update-test-'));
const JOBS_DIR = path.join(ROOT_DIR, 'update-jobs');
const BACKUP_ROOT = path.join(ROOT_DIR, 'backups');

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
    panelUpdateJobsDir: JOBS_DIR,
    panelUpdateBackupRoot: BACKUP_ROOT,
    panelUpdateRepo: 'hicham-pkg/Hytale-Server-Management-Panel',
    panelUpdateInstallEnabled: true,
    panelUpdateMaxDownloadMb: 300,
    panelUpdateBackupRetention: 5,
    githubUpdateToken: undefined,
    ...overrides,
  };
}

async function loadHandler() {
  const mod = await import('../../packages/helper/src/handlers/panel-update');
  return mod;
}

beforeEach(() => {
  vi.resetModules();
  execMock.fn.mockReset();
  process.env = { ...ORIGINAL_ENV };
  fs.rmSync(JOBS_DIR, { recursive: true, force: true });
  fs.rmSync(BACKUP_ROOT, { recursive: true, force: true });
  fs.mkdirSync(JOBS_DIR, { recursive: true });
  fs.mkdirSync(BACKUP_ROOT, { recursive: true });
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe('isAllowedDownloadUrl', () => {
  it('accepts api.github.com /repos/{repo}/...', async () => {
    const { isAllowedDownloadUrl } = await loadHandler();
    expect(
      isAllowedDownloadUrl(
        'https://api.github.com/repos/hicham-pkg/Hytale-Server-Management-Panel/tarball/v1.2.0',
        'hicham-pkg/Hytale-Server-Management-Panel',
      ),
    ).toBe(true);
  });

  it('accepts github.com /{repo}/archive/...', async () => {
    const { isAllowedDownloadUrl } = await loadHandler();
    expect(
      isAllowedDownloadUrl(
        'https://github.com/hicham-pkg/Hytale-Server-Management-Panel/archive/refs/tags/v1.2.0.tar.gz',
        'hicham-pkg/Hytale-Server-Management-Panel',
      ),
    ).toBe(true);
  });

  it('accepts codeload.github.com /{repo}/...', async () => {
    const { isAllowedDownloadUrl } = await loadHandler();
    expect(
      isAllowedDownloadUrl(
        'https://codeload.github.com/hicham-pkg/Hytale-Server-Management-Panel/tar.gz/refs/tags/v1.2.0',
        'hicham-pkg/Hytale-Server-Management-Panel',
      ),
    ).toBe(true);
  });

  it.each([
    ['http://api.github.com/repos/hicham-pkg/Hytale-Server-Management-Panel/tarball/v1.2.0', 'http not https'],
    ['https://evil.example.com/hicham-pkg/Hytale-Server-Management-Panel/archive/v1.2.0.tar.gz', 'foreign host'],
    ['https://api.github.com/repos/attacker/Hytale-Server-Management-Panel/tarball/v1.2.0', 'foreign owner'],
    ['https://github.com/hicham-pkg/evil-repo/archive/v1.2.0.tar.gz', 'foreign repo name'],
    ['https://github.com/hicham-pkg/Hytale-Server-Management-Panel-evil/archive/v1.2.0.tar.gz', 'suffix-injected repo name'],
    ['javascript:alert(1)', 'pseudo-protocol'],
    ['not a url', 'malformed'],
    // V2 hardening: branch downloads must be rejected even on the configured
    // repo. The updater is release-pinned, not git-pull.
    ['https://github.com/hicham-pkg/Hytale-Server-Management-Panel/archive/refs/heads/main.tar.gz', 'branch tarball via /archive/refs/heads/'],
    ['https://github.com/hicham-pkg/Hytale-Server-Management-Panel/archive/main.tar.gz', 'branch tarball via /archive/<branch>'],
    ['https://codeload.github.com/hicham-pkg/Hytale-Server-Management-Panel/tar.gz/refs/heads/main', 'branch tarball via codeload heads'],
    ['https://codeload.github.com/hicham-pkg/Hytale-Server-Management-Panel/legacy.tar.gz/main', 'branch tarball via codeload legacy'],
    ['https://api.github.com/repos/hicham-pkg/Hytale-Server-Management-Panel/git/refs/heads/main', 'branch ref via api'],
    ['https://api.github.com/repos/hicham-pkg/Hytale-Server-Management-Panel/contents/install.sh', 'arbitrary api endpoint'],
  ])('rejects %s (%s)', async (url) => {
    const { isAllowedDownloadUrl } = await loadHandler();
    expect(isAllowedDownloadUrl(url, 'hicham-pkg/Hytale-Server-Management-Panel')).toBe(false);
  });
});

describe('panelUpdateStart', () => {
  const validParams = {
    targetTag: 'v1.2.0',
    downloadUrl:
      'https://api.github.com/repos/hicham-pkg/Hytale-Server-Management-Panel/tarball/v1.2.0',
    tarballType: 'tar.gz' as const,
    expectedSha256: null,
    currentVersion: '1.1.0',
  };

  it('rejects when PANEL_UPDATE_INSTALL_ENABLED=false', async () => {
    const { panelUpdateStart } = await loadHandler();
    const result = await panelUpdateStart(makeConfig({ panelUpdateInstallEnabled: false }), validParams);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/disabled/i);
    expect(execMock.fn).not.toHaveBeenCalled();
  });

  it('rejects malformed targetTag', async () => {
    const { panelUpdateStart } = await loadHandler();
    const result = await panelUpdateStart(
      makeConfig(),
      { ...validParams, targetTag: 'not-a-version' },
    );
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/targetTag/);
  });

  it('rejects downloadUrl outside the configured repo allowlist', async () => {
    const { panelUpdateStart } = await loadHandler();
    const result = await panelUpdateStart(
      makeConfig(),
      { ...validParams, downloadUrl: 'https://github.com/attacker/repo/archive/v1.2.0.tar.gz' },
    );
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/allowlist/i);
  });

  it('rejects malformed expectedSha256', async () => {
    const { panelUpdateStart } = await loadHandler();
    const result = await panelUpdateStart(
      makeConfig(),
      { ...validParams, expectedSha256: 'not-a-hash' },
    );
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/sha/i);
  });

  it('happy path: writes spec.json + status.json + invokes wrapper via sudo', async () => {
    const { panelUpdateStart } = await loadHandler();
    const result = await panelUpdateStart(makeConfig(), validParams);
    expect(result.success).toBe(true);
    expect(result.jobId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    const jobDir = path.join(JOBS_DIR, result.jobId!);
    expect(fs.existsSync(path.join(jobDir, 'spec.json'))).toBe(true);
    expect(fs.existsSync(path.join(jobDir, 'status.json'))).toBe(true);

    const spec = JSON.parse(fs.readFileSync(path.join(jobDir, 'spec.json'), 'utf8')) as Record<string, unknown>;
    expect(spec.kind).toBe('update');
    expect(spec.targetTag).toBe('v1.2.0');
    // CRITICAL: token never written to spec or status.
    const all = JSON.stringify(spec) + fs.readFileSync(path.join(jobDir, 'status.json'), 'utf8');
    expect(all).not.toMatch(/Authorization/i);
    expect(all).not.toMatch(/ghp_|GITHUB_UPDATE_TOKEN/);

    // Wrapper invocation: sudo -n /usr/local/lib/hytale-panel/hytale-panel-updater-trigger start <jobId>
    const calls = execMock.fn.mock.calls;
    expect(calls.length).toBe(1);
    expect(calls[0][0]).toBe('/usr/bin/sudo');
    const args = calls[0][1] as string[];
    expect(args[0]).toBe('-n');
    expect(args[1]).toBe('/usr/local/lib/hytale-panel/hytale-panel-updater-trigger');
    expect(args[2]).toBe('start');
    expect(args[3]).toBe(result.jobId);
  });

  it('rejects when another running job is already on disk', async () => {
    const { panelUpdateStart } = await loadHandler();
    // First call succeeds — and writes status=running.
    const first = await panelUpdateStart(makeConfig(), validParams);
    expect(first.success).toBe(true);
    // Force the prior job's "is-active" check to report active.
    execMock.fn.mockImplementation((_cmd: string, args: string[], _opts: unknown, cb?: (err: Error | null, stdout: string, stderr: string) => void) => {
      // is-active returns 0 when active — model that as no-error.
      if (args.includes('is-active')) {
        if (cb) cb(null, '', '');
      } else {
        if (cb) cb(null, '', '');
      }
    });
    const second = await panelUpdateStart(makeConfig(), validParams);
    expect(second.success).toBe(false);
    expect(second.error).toMatch(/already running/);
  });
});

describe('panelUpdateRollback', () => {
  it('rejects backupPath that escapes the backup root', async () => {
    const { panelUpdateRollback } = await loadHandler();
    const result = await panelUpdateRollback(makeConfig(), {
      backupPath: '/etc/passwd',
    });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/outside backup root/);
  });

  it('rejects backupPath that is exactly the backup root', async () => {
    const { panelUpdateRollback } = await loadHandler();
    const result = await panelUpdateRollback(makeConfig(), {
      backupPath: BACKUP_ROOT,
    });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/outside backup root/);
  });

  it('rejects backupPath that does not exist', async () => {
    const { panelUpdateRollback } = await loadHandler();
    const result = await panelUpdateRollback(makeConfig(), {
      backupPath: path.join(BACKUP_ROOT, 'nonexistent'),
    });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/does not exist/);
  });

  it('rejects when PANEL_UPDATE_INSTALL_ENABLED=false', async () => {
    const { panelUpdateRollback } = await loadHandler();
    const result = await panelUpdateRollback(
      makeConfig({ panelUpdateInstallEnabled: false }),
      {},
    );
    expect(result.success).toBe(false);
  });

  it('happy path: writes rollback spec + invokes trigger', async () => {
    fs.mkdirSync(path.join(BACKUP_ROOT, '20260501T000000Z', 'panel'), { recursive: true });
    const { panelUpdateRollback } = await loadHandler();
    const result = await panelUpdateRollback(makeConfig(), {});
    expect(result.success).toBe(true);
    const spec = JSON.parse(fs.readFileSync(path.join(JOBS_DIR, result.jobId!, 'spec.json'), 'utf8')) as Record<string, unknown>;
    expect(spec.kind).toBe('rollback');
  });
});
