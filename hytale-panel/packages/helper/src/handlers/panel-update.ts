import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { HelperConfig } from '../config';

/**
 * Helper handlers for the Panel Updater (V2).
 *
 * Responsibilities:
 *  - validate inputs (target tag, asset URL, sha256)
 *  - generate a v4 UUID job ID
 *  - write spec.json under /opt/hytale-panel-data/update-jobs/<jobId>/
 *  - acquire/check the global update lock
 *  - call the root-owned trigger wrapper via sudo to start the templated
 *    systemd unit (see hytale-panel-updater@.service)
 *
 * Things this handler intentionally does NOT do:
 *  - perform the update inline (the script runs as a detached systemd unit)
 *  - return logs (the API serves them by reading the read-only mount of
 *    /opt/hytale-panel-data/update-jobs that lives in the API container)
 *  - touch the GitHub token in any code path the dashboard observes
 */

const execFileAsync = promisify(execFile);

const TRIGGER_BIN = '/usr/local/lib/hytale-panel/hytale-panel-updater-trigger';
const SUDO_BIN = '/usr/bin/sudo';

const TAG_REGEX = /^v?(\d+)\.(\d+)\.(\d+)(?:-[A-Za-z0-9.+-]{1,40})?$/;
const SHA256_REGEX = /^[a-f0-9]{64}$/i;
const UUID_V4_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export interface PanelUpdateStartParams {
  targetTag: string;
  downloadUrl: string;
  tarballType: 'tar.gz' | 'zip';
  expectedSha256?: string | null;
  currentVersion: string;
}

export interface PanelUpdateStartResult {
  success: boolean;
  jobId?: string;
  error?: string;
}

export interface PanelUpdateRollbackResult {
  success: boolean;
  jobId?: string;
  error?: string;
}

export interface PanelUpdateCancelResult {
  success: boolean;
  removed?: number;
  error?: string;
}

/**
 * Verify a downloadUrl points at a TAGGED RELEASE on the configured GitHub
 * repo. Tag-only by design — branch downloads (refs/heads/*) are explicitly
 * rejected because the panel updater is a release-pinned flow, not a
 * git-pull flow.
 *
 * Accepted endpoints:
 *   https://api.github.com/repos/{repo}/tarball/<tag>
 *   https://api.github.com/repos/{repo}/zipball/<tag>
 *   https://api.github.com/repos/{repo}/releases/...        (assets list)
 *   https://github.com/{repo}/archive/refs/tags/<tag>.{tar.gz,zip}
 *   https://github.com/{repo}/releases/download/<tag>/...   (release assets)
 *   https://codeload.github.com/{repo}/{tar.gz,zip}/refs/tags/<tag>
 *
 * Rejected examples:
 *   /archive/refs/heads/main.tar.gz             — branch tarball
 *   /archive/main.tar.gz                        — branch tarball (short form)
 *   /codeload.../tar.gz/refs/heads/main          — branch tarball via codeload
 */
export function isAllowedDownloadUrl(url: string, repo: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'https:') return false;

  const path = parsed.pathname;
  switch (parsed.host) {
    case 'api.github.com':
      // Allow tarball/zipball/releases endpoints scoped to the configured repo.
      // Reject anything else under /repos/{repo}/ so e.g. /git/refs/heads/main
      // can't be used to pull a branch via the API.
      return (
        path.startsWith(`/repos/${repo}/tarball/`) ||
        path.startsWith(`/repos/${repo}/zipball/`) ||
        path.startsWith(`/repos/${repo}/releases/`)
      );
    case 'github.com':
      // /archive/ must be /archive/refs/tags/... — explicitly disallow heads.
      return (
        path.startsWith(`/${repo}/archive/refs/tags/`) ||
        path.startsWith(`/${repo}/releases/download/`)
      );
    case 'codeload.github.com':
      // codeload paths look like /{repo}/tar.gz/refs/tags/<tag>
      return (
        path.startsWith(`/${repo}/tar.gz/refs/tags/`) ||
        path.startsWith(`/${repo}/zip/refs/tags/`)
      );
    default:
      return false;
  }
}

function ensureJobDir(jobsDir: string, jobId: string): string {
  const jobDir = path.join(jobsDir, jobId);
  fs.mkdirSync(jobDir, { recursive: true, mode: 0o770 });
  return jobDir;
}

/**
 * True if any non-terminal status.json exists under the jobs dir. We also
 * sanity-check by asking systemd whether the unit is active for that ID.
 */
async function isAnyJobRunning(jobsDir: string): Promise<boolean> {
  if (!fs.existsSync(jobsDir)) return false;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(jobsDir, { withFileTypes: true });
  } catch {
    return false;
  }
  for (const ent of entries) {
    if (!ent.isDirectory() || !UUID_V4_REGEX.test(ent.name)) continue;
    const statusPath = path.join(jobsDir, ent.name, 'status.json');
    if (!fs.existsSync(statusPath)) continue;
    try {
      const raw = fs.readFileSync(statusPath, 'utf8');
      const parsed = JSON.parse(raw) as { status?: string };
      if (parsed.status === 'running') {
        // Cross-check with systemd: the job might have been killed without
        // updating status.json (e.g. host crash). If the unit isn't active
        // we treat it as orphaned and let a new job start.
        const active = await unitIsActive(ent.name).catch(() => false);
        if (active) return true;
      }
    } catch {
      // unreadable / malformed — treat conservatively as not running so an
      // admin can recover by clicking again.
    }
  }
  return false;
}

async function unitIsActive(jobId: string): Promise<boolean> {
  try {
    await execFileAsync(SUDO_BIN, ['-n', TRIGGER_BIN, 'is-active', jobId], { timeout: 5_000 });
    return true;
  } catch {
    return false;
  }
}

async function startUnit(jobId: string): Promise<void> {
  await execFileAsync(SUDO_BIN, ['-n', TRIGGER_BIN, 'start', jobId], { timeout: 10_000 });
}

/**
 * Start an update job. Validates inputs, writes spec.json, fires the trigger.
 * The actual update runs detached — it survives helper/API restart.
 */
export async function panelUpdateStart(
  config: HelperConfig,
  rawParams: unknown,
): Promise<PanelUpdateStartResult> {
  if (!config.panelUpdateInstallEnabled) {
    return { success: false, error: 'Panel updates are disabled (PANEL_UPDATE_INSTALL_ENABLED=false)' };
  }

  // Strict input validation — every field is rechecked even though the API
  // already parses them. Helper is the trust boundary.
  const params = rawParams as Partial<PanelUpdateStartParams>;
  if (
    !params ||
    typeof params.targetTag !== 'string' ||
    typeof params.downloadUrl !== 'string' ||
    typeof params.currentVersion !== 'string' ||
    (params.tarballType !== 'tar.gz' && params.tarballType !== 'zip')
  ) {
    return { success: false, error: 'invalid params' };
  }
  if (!TAG_REGEX.test(params.targetTag)) {
    return { success: false, error: 'invalid targetTag format' };
  }
  if (!isAllowedDownloadUrl(params.downloadUrl, config.panelUpdateRepo)) {
    return { success: false, error: 'downloadUrl not in allowlist for configured repo' };
  }
  if (
    params.expectedSha256 !== undefined &&
    params.expectedSha256 !== null &&
    !SHA256_REGEX.test(params.expectedSha256)
  ) {
    return { success: false, error: 'invalid expectedSha256' };
  }

  if (await isAnyJobRunning(config.panelUpdateJobsDir)) {
    return { success: false, error: 'Another panel update or rollback job is already running' };
  }

  const jobId = crypto.randomUUID();
  if (!UUID_V4_REGEX.test(jobId)) {
    // Defensive: should never happen with crypto.randomUUID() on Node 18+.
    return { success: false, error: 'failed to generate job id' };
  }
  const jobDir = ensureJobDir(config.panelUpdateJobsDir, jobId);

  const spec = {
    kind: 'update' as const,
    jobId,
    targetTag: params.targetTag,
    downloadUrl: params.downloadUrl,
    tarballType: params.tarballType,
    expectedSha256: params.expectedSha256 ?? null,
    currentVersion: params.currentVersion,
    createdAt: new Date().toISOString(),
  };
  fs.writeFileSync(path.join(jobDir, 'spec.json'), JSON.stringify(spec, null, 2), { mode: 0o660 });
  // Pre-create empty status/logs so the API's read-only mount can poll
  // without 404s before the unit's systemd output redirect kicks in.
  fs.writeFileSync(
    path.join(jobDir, 'status.json'),
    JSON.stringify({ jobId, kind: 'update', step: 0, stepName: 'queued', totalSteps: 8, status: 'running', startedAt: spec.createdAt, endedAt: null, error: null }) + '\n',
    { mode: 0o660 },
  );
  fs.writeFileSync(path.join(jobDir, 'logs.txt'), '', { mode: 0o660 });

  try {
    await startUnit(jobId);
  } catch (err) {
    return {
      success: false,
      error: `Failed to start updater unit: ${(err as Error).message.slice(0, 200)}`,
    };
  }
  return { success: true, jobId };
}

/**
 * Start a rollback job. If backupPath is provided, must point to an existing
 * directory under panelUpdateBackupRoot. Otherwise the script picks the most
 * recent backup automatically.
 */
export async function panelUpdateRollback(
  config: HelperConfig,
  rawParams: unknown,
): Promise<PanelUpdateRollbackResult> {
  if (!config.panelUpdateInstallEnabled) {
    return { success: false, error: 'Panel updates are disabled' };
  }

  const params = (rawParams ?? {}) as { backupPath?: string };
  let backupPath: string | undefined;
  if (typeof params.backupPath === 'string' && params.backupPath.length > 0) {
    // Must be a real directory under the configured backup root — no traversal.
    const resolved = path.resolve(params.backupPath);
    const root = path.resolve(config.panelUpdateBackupRoot);
    if (!resolved.startsWith(root + path.sep) || resolved === root) {
      return { success: false, error: 'backupPath outside backup root' };
    }
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
      return { success: false, error: 'backupPath does not exist' };
    }
    backupPath = resolved;
  }

  if (await isAnyJobRunning(config.panelUpdateJobsDir)) {
    return { success: false, error: 'Another panel update or rollback job is already running' };
  }

  const jobId = crypto.randomUUID();
  const jobDir = ensureJobDir(config.panelUpdateJobsDir, jobId);
  const spec = {
    kind: 'rollback' as const,
    jobId,
    backupPath: backupPath ?? null,
    createdAt: new Date().toISOString(),
  };
  fs.writeFileSync(path.join(jobDir, 'spec.json'), JSON.stringify(spec, null, 2), { mode: 0o660 });
  fs.writeFileSync(
    path.join(jobDir, 'status.json'),
    JSON.stringify({ jobId, kind: 'rollback', step: 0, stepName: 'queued', totalSteps: 6, status: 'running', startedAt: spec.createdAt, endedAt: null, error: null }) + '\n',
    { mode: 0o660 },
  );
  fs.writeFileSync(path.join(jobDir, 'logs.txt'), '', { mode: 0o660 });

  try {
    await startUnit(jobId);
  } catch (err) {
    return {
      success: false,
      error: `Failed to start rollback unit: ${(err as Error).message.slice(0, 200)}`,
    };
  }
  return { success: true, jobId };
}

/**
 * Garbage-collect stale staging dirs from terminated jobs. Useful as a
 * maintenance hook or after a hard crash. Never deletes a job whose status
 * is "running".
 */
export async function panelUpdateCancelStaging(
  config: HelperConfig,
): Promise<PanelUpdateCancelResult> {
  if (!fs.existsSync(config.panelUpdateJobsDir)) {
    return { success: true, removed: 0 };
  }
  let removed = 0;
  for (const ent of fs.readdirSync(config.panelUpdateJobsDir, { withFileTypes: true })) {
    if (!ent.isDirectory() || !UUID_V4_REGEX.test(ent.name)) continue;
    const dir = path.join(config.panelUpdateJobsDir, ent.name);
    const statusFile = path.join(dir, 'status.json');
    let status = 'unknown';
    try {
      const parsed = JSON.parse(fs.readFileSync(statusFile, 'utf8')) as { status?: string };
      status = parsed.status ?? 'unknown';
    } catch {
      /* missing/malformed — treat as terminal */
    }
    if (status === 'running') continue;
    // Older than 24h, prune. We keep recent terminal jobs so the dashboard
    // can still surface their final logs.
    try {
      const mtime = fs.statSync(dir).mtimeMs;
      if (Date.now() - mtime > 24 * 60 * 60 * 1000) {
        fs.rmSync(dir, { recursive: true, force: true });
        removed += 1;
      }
    } catch {
      /* ignore */
    }
  }
  return { success: true, removed };
}
