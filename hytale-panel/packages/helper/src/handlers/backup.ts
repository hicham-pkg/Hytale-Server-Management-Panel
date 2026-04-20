import * as fs from 'fs/promises';
import { createReadStream } from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { pipeline } from 'stream/promises';
import { safeExec } from '../utils/command';
import { guardPath } from '../utils/path-guard';
import { getServerStatus } from './server-control';
import { BACKUP_FILENAME_REGEX, UUID_REGEX } from '@hytale-panel/shared';
import type { HelperConfig } from '../config';
import { enqueueGlobalOperation } from '../utils/operation-lock';

// M2: normalize error messages returned across the RPC boundary so they
// never leak host filesystem paths or raw errno details. The full error
// is still logged on the helper side for operators.
function normalizeError(err: unknown, fallback: string): string {
  const code = (err as NodeJS.ErrnoException)?.code;
  if (code === 'ENOENT') return 'Resource not found';
  if (code === 'EACCES' || code === 'EPERM') return 'Operation denied';
  console.error('[helper/backup]', err);
  return fallback;
}

export interface BackupInfo {
  id: string;
  filename: string;
  sizeBytes: number;
  sha256: string;
  createdAt: string;
}

async function computeFileSha256(filePath: string): Promise<string> {
  const hasher = crypto.createHash('sha256');
  await pipeline(createReadStream(filePath), hasher);
  return hasher.digest('hex');
}

export function validateBackupEntries(entries: string[], expectedRootDir: string): { valid: boolean; error?: string } {
  if (entries.length === 0) {
    return { valid: false, error: 'Backup archive is empty or invalid' };
  }

  for (const entry of entries) {
    if (entry.startsWith('/') || entry.includes('..')) {
      return { valid: false, error: 'Backup contains unsafe paths (absolute or traversal)' };
    }

    if (entry !== expectedRootDir && !entry.startsWith(`${expectedRootDir}/`)) {
      return { valid: false, error: `Backup contains unexpected top-level path: ${entry}` };
    }
  }

  return { valid: true };
}

export function validateBackupEntryTypes(verboseEntries: string[]): { valid: boolean; error?: string } {
  for (const entry of verboseEntries) {
    const type = entry[0];
    if (!type || !['-', 'd'].includes(type)) {
      return {
        valid: false,
        error: 'Backup contains unsupported entry types (only regular files and directories are allowed)',
      };
    }
  }

  return { valid: true };
}

/**
 * Create a backup of the Hytale server worlds directory.
 */
export async function createBackup(
  config: HelperConfig,
  label?: string
): Promise<{ success: boolean; backup?: BackupInfo; error?: string }> {
  try {
    // Ensure backup directory exists
    await fs.mkdir(config.backupPath, { recursive: true, mode: 0o770 });

    const id = crypto.randomUUID();
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const safeLabel = label ? `_${label.replace(/[^a-zA-Z0-9_\-]/g, '')}` : '';
    const filename = `${timestamp}${safeLabel}.tar.gz`;

    const backupFilePath = await guardPath(
      path.join(config.backupPath, filename),
      config.backupPath
    );

    // Check worlds directory exists
    const worldsPath = await guardPath(config.worldsPath, config.hytaleRoot);
    try {
      await fs.access(worldsPath);
    } catch {
      return { success: false, error: 'Worlds directory not found' };
    }

    // Create tar.gz backup
    const result = await safeExec('/usr/bin/tar', [
      '-czf',
      backupFilePath,
      '-C',
      path.dirname(worldsPath),
      path.basename(worldsPath),
    ], { timeout: 300_000 }); // 5 minute timeout for large worlds

    if (result.exitCode !== 0) {
      console.error('[helper/backup] tar create stderr:', result.stderr);
      return { success: false, error: 'Backup operation failed' };
    }

    const sha256 = await computeFileSha256(backupFilePath);

    const stat = await fs.stat(backupFilePath);

    return {
      success: true,
      backup: {
        id,
        filename,
        sizeBytes: stat.size,
        sha256,
        createdAt: new Date().toISOString(),
      },
    };
  } catch (err) {
    return { success: false, error: normalizeError(err, 'Backup operation failed') };
  }
}

/**
 * List all available backups.
 */
export async function listBackups(
  config: HelperConfig
): Promise<{ success: boolean; backups: Array<{ filename: string; sizeBytes: number; createdAt: string }>; error?: string }> {
  try {
    await fs.mkdir(config.backupPath, { recursive: true, mode: 0o770 });
    const files = await fs.readdir(config.backupPath);

    const backups: Array<{ filename: string; sizeBytes: number; createdAt: string }> = [];

    for (const file of files) {
      if (!BACKUP_FILENAME_REGEX.test(file)) continue;

      const filePath = await guardPath(path.join(config.backupPath, file), config.backupPath);
      const stat = await fs.stat(filePath);
      if (!stat.isFile()) continue;

      backups.push({
        filename: file,
        sizeBytes: stat.size,
        createdAt: stat.birthtime.toISOString(),
      });
    }

    backups.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
    return { success: true, backups };
  } catch (err) {
    return { success: false, backups: [], error: normalizeError(err, 'Backup list failed') };
  }
}

/**
 * Restore a backup. Server MUST be stopped first.
 * Creates a safety snapshot before restoring.
 */
async function _restoreBackup(
  config: HelperConfig,
  filename: string
): Promise<{ success: boolean; safetyBackup?: string; error?: string }> {
  try {
    // Validate filename
    if (!BACKUP_FILENAME_REGEX.test(filename)) {
      return { success: false, error: 'Invalid backup filename' };
    }

    // CRITICAL: Server must be stopped
    const status = await getServerStatus(config);
    if (status.running) {
      return { success: false, error: 'Cannot restore while server is running. Stop the server first.' };
    }

    const backupFilePath = await guardPath(
      path.join(config.backupPath, filename),
      config.backupPath
    );

    // Verify backup file exists
    try {
      await fs.access(backupFilePath);
    } catch {
      return { success: false, error: 'Backup file not found' };
    }

    const worldsPath = await guardPath(config.worldsPath, config.hytaleRoot);
    const expectedRootDir = path.basename(worldsPath).replace(/\/+$/, '') || 'worlds';

    // Validate tar contents — no absolute paths, no traversal, no links/devices,
    // and only the expected top-level worlds directory.
    const listResult = await safeExec('/usr/bin/tar', ['-tzf', backupFilePath]);
    if (listResult.exitCode !== 0) {
      return { success: false, error: 'Backup archive is corrupted or invalid' };
    }

    const entries = listResult.stdout.split('\n').filter(Boolean);
    const entryValidation = validateBackupEntries(entries, expectedRootDir);
    if (!entryValidation.valid) {
      return { success: false, error: entryValidation.error };
    }

    const verboseResult = await safeExec('/usr/bin/tar', ['-tvzf', backupFilePath]);
    if (verboseResult.exitCode !== 0) {
      return { success: false, error: 'Backup archive is corrupted or invalid' };
    }

    const typeValidation = validateBackupEntryTypes(verboseResult.stdout.split('\n').filter(Boolean));
    if (!typeValidation.valid) {
      return { success: false, error: typeValidation.error };
    }

    // Create safety snapshot before restore. M5: if the safety backup
    // fails we must NOT proceed — the subsequent rm -rf on worlds/ would
    // otherwise cause unrecoverable data loss. Abort with a clear error.
    const safetyResult = await createBackup(config, 'safety-pre-restore');
    if (!safetyResult.success) {
      console.error(
        '[helper/backup] safety-pre-restore backup failed; aborting restore:',
        safetyResult.error
      );
      return {
        success: false,
        error: 'Pre-restore safety backup failed; aborting restore to prevent data loss',
      };
    }
    const safetyBackupName = safetyResult.backup?.filename;

    // Remove current worlds directory
    try {
      await fs.rm(worldsPath, { recursive: true, force: true });
    } catch {
      // May not exist
    }

    // Extract backup
    const extractResult = await safeExec('/usr/bin/tar', [
      '-xzf',
      backupFilePath,
      '--no-same-owner',
      '--no-same-permissions',
      '-C',
      path.dirname(worldsPath),
    ], { timeout: 300_000 });

    if (extractResult.exitCode !== 0) {
      console.error('[helper/backup] tar extract stderr:', extractResult.stderr);
      return { success: false, error: 'Backup operation failed' };
    }

    return { success: true, safetyBackup: safetyBackupName };
  } catch (err) {
    return { success: false, error: normalizeError(err, 'Backup operation failed') };
  }
}

export function restoreBackup(
  config: HelperConfig,
  filename: string
): Promise<{ success: boolean; safetyBackup?: string; error?: string }> {
  return enqueueGlobalOperation(() => _restoreBackup(config, filename));
}

/**
 * Delete a backup file.
 */
export async function deleteBackup(
  config: HelperConfig,
  filename: string
): Promise<{ success: boolean; error?: string }> {
  try {
    if (!BACKUP_FILENAME_REGEX.test(filename)) {
      return { success: false, error: 'Invalid backup filename' };
    }

    const backupFilePath = await guardPath(
      path.join(config.backupPath, filename),
      config.backupPath
    );

    await fs.unlink(backupFilePath);
    return { success: true };
  } catch (err) {
    return { success: false, error: normalizeError(err, 'Backup operation failed') };
  }
}

/**
 * Compute the SHA256 of an existing backup file. Used by the API to verify
 * integrity against the recorded hash before a restore.
 */
export async function hashBackup(
  config: HelperConfig,
  filename: string
): Promise<{ success: boolean; sha256?: string; error?: string }> {
  try {
    if (!BACKUP_FILENAME_REGEX.test(filename)) {
      return { success: false, error: 'Invalid backup filename' };
    }

    const backupFilePath = await guardPath(
      path.join(config.backupPath, filename),
      config.backupPath
    );

    try {
      await fs.access(backupFilePath);
    } catch {
      return { success: false, error: 'Backup file not found' };
    }

    const sha256 = await computeFileSha256(backupFilePath);
    return { success: true, sha256 };
  } catch (err) {
    return { success: false, error: normalizeError(err, 'Backup operation failed') };
  }
}
