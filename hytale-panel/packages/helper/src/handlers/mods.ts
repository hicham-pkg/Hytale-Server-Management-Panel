import * as crypto from 'crypto';
import { createReadStream } from 'fs';
import * as fs from 'fs/promises';
import * as path from 'path';
import { pipeline } from 'stream/promises';
import { MOD_FILENAME_REGEX, UUID_REGEX } from '@hytale-panel/shared';
import type { HelperConfig } from '../config';
import { guardPath, isRegularFile } from '../utils/path-guard';
import { readLogs } from './logs';
import { restartServer } from './server-control';

export type ModStatus = 'active' | 'disabled';

export interface ModInfo {
  name: string;
  sizeBytes: number;
  sha256: string;
  modifiedAt: string;
  status: ModStatus;
}

export interface ModRestartVerifyResult {
  restartSucceeded: boolean;
  startupOk: boolean;
  errors: string[];
  rollbackPerformed: boolean;
  rollbackBackupName?: string;
  rollbackRestartSucceeded?: boolean;
  message: string;
}

const MOD_STARTUP_ERROR_PATTERNS = [
  /ClassNotFoundException/i,
  /NoClassDefFoundError/i,
  /NoSuchMethodError/i,
  /NoSuchFieldError/i,
  /ClassCastException/i,
  /Failed to load plugin/i,
  /Error loading mod/i,
];

let modOperationLock: Promise<unknown> = Promise.resolve();

function enqueueModOperation<T>(op: () => Promise<T>): Promise<T> {
  const run = modOperationLock.then(op, op);
  modOperationLock = run.catch(() => undefined);
  return run;
}

function nowIso(): string {
  return new Date().toISOString();
}

function timestampForPath(): string {
  return nowIso().replace(/[:.]/g, '-');
}

function assertValidModName(name: string): string {
  if (!MOD_FILENAME_REGEX.test(name) || name.includes('/') || name.includes('\\') || name.startsWith('.')) {
    throw new Error('Invalid mod filename');
  }
  return name;
}

function assertValidStagedId(stagedId: string): string {
  if (!UUID_REGEX.test(stagedId)) {
    throw new Error('Invalid staged mod id');
  }
  return stagedId;
}

async function ensureModDirectories(config: HelperConfig): Promise<void> {
  await fs.mkdir(config.modsPath, { recursive: true, mode: 0o2770 });
  await fs.mkdir(config.disabledModsPath, { recursive: true, mode: 0o2770 });
  await fs.mkdir(config.modBackupPath, { recursive: true, mode: 0o2770 });
}

async function computeFileSha256(filePath: string): Promise<string> {
  const hasher = crypto.createHash('sha256');
  await pipeline(createReadStream(filePath), hasher);
  return hasher.digest('hex');
}

async function getModPath(config: HelperConfig, status: ModStatus, name: string): Promise<string> {
  const safeName = assertValidModName(name);
  const base = status === 'active' ? config.modsPath : config.disabledModsPath;
  return guardPath(path.join(base, safeName), base);
}

async function getStagedFilePath(config: HelperConfig, stagedId: string): Promise<string> {
  const safeId = assertValidStagedId(stagedId);
  return guardPath(path.join(config.modUploadStagingPath, `${safeId}.upload`), config.modUploadStagingPath);
}

async function getStagedMetadataPath(config: HelperConfig, stagedId: string): Promise<string> {
  const safeId = assertValidStagedId(stagedId);
  return guardPath(path.join(config.modUploadStagingPath, `${safeId}.json`), config.modUploadStagingPath);
}

async function readStagedMetadata(
  metadataPath: string,
  stagedId: string
): Promise<{ stagedId: string; sanitizedName: string; sha256: string }> {
  const raw = await fs.readFile(metadataPath, 'utf8').catch(() => {
    throw new Error('Staged mod metadata not found');
  });
  const parsed = JSON.parse(raw) as { stagedId?: unknown; sanitizedName?: unknown; sha256?: unknown };
  if (
    parsed.stagedId !== stagedId ||
    typeof parsed.sanitizedName !== 'string' ||
    typeof parsed.sha256 !== 'string' ||
    !MOD_FILENAME_REGEX.test(parsed.sanitizedName) ||
    !/^[a-f0-9]{64}$/i.test(parsed.sha256)
  ) {
    throw new Error('Staged mod metadata is invalid');
  }
  return {
    stagedId,
    sanitizedName: parsed.sanitizedName,
    sha256: parsed.sha256,
  };
}

async function removeStagedArtifacts(stagedPath: string, metadataPath: string): Promise<void> {
  await Promise.all([
    fs.rm(stagedPath, { force: true }),
    fs.rm(metadataPath, { force: true }),
  ]);
}

async function readModDir(config: HelperConfig, status: ModStatus): Promise<ModInfo[]> {
  const base = status === 'active' ? config.modsPath : config.disabledModsPath;
  await fs.mkdir(base, { recursive: true, mode: 0o2770 });

  const entries = await fs.readdir(base, { withFileTypes: true });
  const mods: ModInfo[] = [];

  for (const entry of entries) {
    if (!entry.isFile() || !MOD_FILENAME_REGEX.test(entry.name)) {
      continue;
    }

    const filePath = await getModPath(config, status, entry.name);
    if (!(await isRegularFile(filePath))) {
      continue;
    }

    const stat = await fs.stat(filePath);
    mods.push({
      name: entry.name,
      sizeBytes: stat.size,
      sha256: await computeFileSha256(filePath),
      modifiedAt: stat.mtime.toISOString(),
      status,
    });
  }

  mods.sort((a, b) => a.name.localeCompare(b.name));
  return mods;
}

async function copySafeModFiles(sourceDir: string, targetDir: string): Promise<void> {
  await fs.mkdir(sourceDir, { recursive: true, mode: 0o2770 });
  await fs.mkdir(targetDir, { recursive: true, mode: 0o2770 });
  const entries = await fs.readdir(sourceDir, { withFileTypes: true });

  for (const entry of entries) {
    if (!entry.isFile() || !MOD_FILENAME_REGEX.test(entry.name)) {
      continue;
    }

    const sourcePath = await guardPath(path.join(sourceDir, entry.name), sourceDir);
    if (!(await isRegularFile(sourcePath))) {
      continue;
    }

    const targetPath = await guardPath(path.join(targetDir, entry.name), targetDir);
    await fs.copyFile(sourcePath, targetPath);
    await fs.chmod(targetPath, 0o660);
  }
}

export async function listMods(config: HelperConfig): Promise<{ active: ModInfo[]; disabled: ModInfo[] }> {
  await ensureModDirectories(config);
  return {
    active: await readModDir(config, 'active'),
    disabled: await readModDir(config, 'disabled'),
  };
}

async function listBackupDirs(config: HelperConfig): Promise<Array<{ name: string; path: string; mtimeMs: number }>> {
  await fs.mkdir(config.modBackupPath, { recursive: true, mode: 0o2770 });
  const entries = await fs.readdir(config.modBackupPath, { withFileTypes: true });
  const backups = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const backupPath = await guardPath(path.join(config.modBackupPath, entry.name), config.modBackupPath);
    const stat = await fs.stat(backupPath);
    backups.push({ name: entry.name, path: backupPath, mtimeMs: stat.mtimeMs });
  }

  backups.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return backups;
}

async function pruneOldBackups(config: HelperConfig): Promise<void> {
  const backups = await listBackupDirs(config);
  const stale = backups.slice(config.modBackupRetention);
  await Promise.all(stale.map((backup) => fs.rm(backup.path, { recursive: true, force: true })));
}

async function backupModsUnlocked(
  config: HelperConfig,
  reason = 'manual',
  options: { prune?: boolean } = {}
): Promise<{ backupName: string }> {
  await ensureModDirectories(config);
  const reasonPart = reason.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 40) || 'manual';
  const backupName = `${timestampForPath()}_${reasonPart}_${crypto.randomUUID()}`;
  const backupPath = await guardPath(path.join(config.modBackupPath, backupName), config.modBackupPath);
  const modsSnapshotPath = await guardPath(path.join(backupPath, 'mods'), backupPath);
  const disabledSnapshotPath = await guardPath(path.join(backupPath, 'mods-disabled'), backupPath);

  await fs.mkdir(backupPath, { recursive: true, mode: 0o2770 });
  await copySafeModFiles(config.modsPath, modsSnapshotPath);
  await copySafeModFiles(config.disabledModsPath, disabledSnapshotPath);

  if (options.prune !== false) {
    await pruneOldBackups(config);
  }
  return { backupName };
}

export function backupMods(config: HelperConfig, reason = 'manual'): Promise<{ backupName: string }> {
  return enqueueModOperation(() => backupModsUnlocked(config, reason));
}

export async function installStagedMod(
  config: HelperConfig,
  stagedId: string,
  sanitizedName: string,
  expectedSha256: string,
  replace = false
): Promise<{ mod: ModInfo; backupName: string }> {
  return enqueueModOperation(async () => {
    await ensureModDirectories(config);
    const finalName = assertValidModName(sanitizedName);
    const stagedPath = await getStagedFilePath(config, stagedId);
    const metadataPath = await getStagedMetadataPath(config, stagedId);
    const metadata = await readStagedMetadata(metadataPath, stagedId);

    if (metadata.sanitizedName !== finalName || metadata.sha256 !== expectedSha256) {
      await removeStagedArtifacts(stagedPath, metadataPath);
      throw new Error('Staged mod metadata mismatch');
    }

    if (!(await isRegularFile(stagedPath))) {
      await fs.rm(metadataPath, { force: true });
      throw new Error('Staged mod file not found');
    }

    const actualSha256 = await computeFileSha256(stagedPath);
    if (actualSha256 !== expectedSha256) {
      await removeStagedArtifacts(stagedPath, metadataPath);
      throw new Error('Staged mod checksum mismatch');
    }

    const finalPath = await getModPath(config, 'active', finalName);
    const exists = await isRegularFile(finalPath);
    if (exists && !replace) {
      throw new Error('A mod with this name already exists');
    }

    const { backupName } = await backupModsUnlocked(config, `install-${finalName}`);
    const tmpPath = await guardPath(
      path.join(config.modsPath, `.${finalName}.${assertValidStagedId(stagedId)}.tmp`),
      config.modsPath
    );

    try {
      await fs.copyFile(stagedPath, tmpPath);
      await fs.chmod(tmpPath, 0o660);
      await fs.rename(tmpPath, finalPath);
      await removeStagedArtifacts(stagedPath, metadataPath);
    } catch (err) {
      await fs.rm(tmpPath, { force: true }).catch(() => undefined);
      throw err;
    }

    const stat = await fs.stat(finalPath);
    return {
      backupName,
      mod: {
        name: finalName,
        sizeBytes: stat.size,
        sha256: actualSha256,
        modifiedAt: stat.mtime.toISOString(),
        status: 'active',
      },
    };
  });
}

export function disableMod(config: HelperConfig, name: string): Promise<{ backupName: string }> {
  return enqueueModOperation(async () => {
    await ensureModDirectories(config);
    const safeName = assertValidModName(name);
    const sourcePath = await getModPath(config, 'active', safeName);
    const targetPath = await getModPath(config, 'disabled', safeName);

    if (!(await isRegularFile(sourcePath))) {
      throw new Error('Active mod not found');
    }
    if (await isRegularFile(targetPath)) {
      throw new Error('Disabled mod with this name already exists');
    }

    const { backupName } = await backupModsUnlocked(config, `disable-${safeName}`);
    await fs.rename(sourcePath, targetPath);
    return { backupName };
  });
}

export function enableMod(config: HelperConfig, name: string): Promise<{ backupName: string }> {
  return enqueueModOperation(async () => {
    await ensureModDirectories(config);
    const safeName = assertValidModName(name);
    const sourcePath = await getModPath(config, 'disabled', safeName);
    const targetPath = await getModPath(config, 'active', safeName);

    if (!(await isRegularFile(sourcePath))) {
      throw new Error('Disabled mod not found');
    }
    if (await isRegularFile(targetPath)) {
      throw new Error('Active mod with this name already exists');
    }

    const { backupName } = await backupModsUnlocked(config, `enable-${safeName}`);
    await fs.rename(sourcePath, targetPath);
    return { backupName };
  });
}

export function removeMod(config: HelperConfig, name: string): Promise<{ backupName: string; removedFrom: ModStatus }> {
  return enqueueModOperation(async () => {
    await ensureModDirectories(config);
    const safeName = assertValidModName(name);
    const activePath = await getModPath(config, 'active', safeName);
    const disabledPath = await getModPath(config, 'disabled', safeName);
    const activeExists = await isRegularFile(activePath);
    const disabledExists = await isRegularFile(disabledPath);

    if (!activeExists && !disabledExists) {
      throw new Error('Mod not found');
    }

    const { backupName } = await backupModsUnlocked(config, `delete-${safeName}`);
    if (activeExists) {
      await fs.rm(activePath, { force: true });
      return { backupName, removedFrom: 'active' };
    }

    await fs.rm(disabledPath, { force: true });
    return { backupName, removedFrom: 'disabled' };
  });
}

async function rollbackModsBackupUnlocked(config: HelperConfig, backupName?: string): Promise<{ backupName: string }> {
  await ensureModDirectories(config);
  const backups = await listBackupDirs(config);
  const backup = backupName
    ? backups.find((candidate) => candidate.name === backupName)
    : backups[0];

  if (!backup) {
    throw new Error('No mods backup available');
  }

  const snapshotPath = await guardPath(path.join(backup.path, 'mods'), backup.path);
  if (!(await fs.stat(snapshotPath).then((stat) => stat.isDirectory()).catch(() => false))) {
    throw new Error('Mods backup is invalid');
  }
  const disabledSnapshotPath = await guardPath(path.join(backup.path, 'mods-disabled'), backup.path);
  const hasDisabledSnapshot = await fs.stat(disabledSnapshotPath)
    .then((stat) => stat.isDirectory())
    .catch(() => false);

  const swapId = crypto.randomUUID();
  const activeParent = path.dirname(config.modsPath);
  const disabledParent = path.dirname(config.disabledModsPath);
  const activeTempPath = await guardPath(path.join(activeParent, `.mods-rollback-${swapId}.tmp`), activeParent);
  const disabledTempPath = await guardPath(path.join(disabledParent, `.mods-disabled-rollback-${swapId}.tmp`), disabledParent);
  const activeOldPath = await guardPath(path.join(activeParent, `.mods-rollback-${swapId}.old`), activeParent);
  const disabledOldPath = await guardPath(path.join(disabledParent, `.mods-disabled-rollback-${swapId}.old`), disabledParent);

  await fs.rm(activeTempPath, { recursive: true, force: true });
  await fs.rm(disabledTempPath, { recursive: true, force: true });
  await fs.mkdir(activeTempPath, { recursive: true, mode: 0o2770 });
  await fs.mkdir(disabledTempPath, { recursive: true, mode: 0o2770 });
  await copySafeModFiles(snapshotPath, activeTempPath);
  if (hasDisabledSnapshot) {
    await copySafeModFiles(disabledSnapshotPath, disabledTempPath);
  }

  await backupModsUnlocked(config, 'pre-rollback', { prune: false });

  try {
    await fs.rename(config.modsPath, activeOldPath);
    await fs.rename(config.disabledModsPath, disabledOldPath);
    await fs.rename(activeTempPath, config.modsPath);
    await fs.rename(disabledTempPath, config.disabledModsPath);
    await fs.rm(activeOldPath, { recursive: true, force: true });
    await fs.rm(disabledOldPath, { recursive: true, force: true });
  } catch (err) {
    await Promise.all([
      fs.rm(activeTempPath, { recursive: true, force: true }).catch(() => undefined),
      fs.rm(disabledTempPath, { recursive: true, force: true }).catch(() => undefined),
    ]);

    const activeOldExists = await fs.stat(activeOldPath).then(() => true).catch(() => false);
    const disabledOldExists = await fs.stat(disabledOldPath).then(() => true).catch(() => false);
    if (activeOldExists) {
      await fs.rm(config.modsPath, { recursive: true, force: true }).catch(() => undefined);
      await fs.rename(activeOldPath, config.modsPath).catch(() => undefined);
    }
    if (disabledOldExists) {
      await fs.rm(config.disabledModsPath, { recursive: true, force: true }).catch(() => undefined);
      await fs.rename(disabledOldPath, config.disabledModsPath).catch(() => undefined);
    }
    throw err;
  }

  await pruneOldBackups(config);

  return { backupName: backup.name };
}

export function rollbackModsBackup(config: HelperConfig, backupName?: string): Promise<{ backupName: string }> {
  return enqueueModOperation(() => rollbackModsBackupUnlocked(config, backupName));
}

function detectStartupErrors(lines: string[]): string[] {
  return lines
    .filter((line) => MOD_STARTUP_ERROR_PATTERNS.some((pattern) => pattern.test(line)))
    .slice(-20);
}

export function restartAndVerifyServer(
  config: HelperConfig,
  autoRollback = false
): Promise<ModRestartVerifyResult> {
  return enqueueModOperation(async () => {
    const restartResult = await restartServer(config);
    const logs = await readLogs(config, 200);
    const errors = logs.success ? detectStartupErrors(logs.lines) : [];
    const startupOk = restartResult.success && errors.length === 0;

    if (startupOk || !autoRollback) {
      return {
        restartSucceeded: restartResult.success,
        startupOk,
        errors,
        rollbackPerformed: false,
        message: startupOk
          ? 'Server restarted and no common mod startup errors were detected'
          : restartResult.message,
      };
    }

    const rollback = await rollbackModsBackupUnlocked(config);
    const rollbackRestart = await restartServer(config);
    return {
      restartSucceeded: restartResult.success,
      startupOk: false,
      errors,
      rollbackPerformed: true,
      rollbackBackupName: rollback.backupName,
      rollbackRestartSucceeded: rollbackRestart.success,
      message: rollbackRestart.success
        ? 'Startup verification failed; mods were rolled back and the server restarted'
        : 'Startup verification failed; rollback was attempted but restart still failed',
    };
  });
}
