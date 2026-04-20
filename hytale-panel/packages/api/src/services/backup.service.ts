import { desc, eq, inArray } from 'drizzle-orm';
import { callHelper } from './helper-client';
import { getDb, schema } from '../db';
import { HelperBackupListDataSchema } from '@hytale-panel/shared';
import type { BackupMeta, HelperBackupFile } from '@hytale-panel/shared';

const { backupMetadata } = schema;
const BACKUP_CREATE_TIMEOUT_MS = 6 * 60 * 1000;
const BACKUP_HASH_TIMEOUT_MS = 6 * 60 * 1000;
const BACKUP_RESTORE_TIMEOUT_MS = 12 * 60 * 1000;

export interface ListBackupsResult {
  backups: BackupMeta[];
  helperOffline: boolean;
}

async function listBackupsFromDbFallback(): Promise<ListBackupsResult> {
  const db = getDb();
  const rows = await db
    .select()
    .from(backupMetadata)
    .orderBy(desc(backupMetadata.createdAt));

  return {
    helperOffline: true,
    backups: rows.map((r) => ({
      id: r.id,
      filename: r.filename,
      label: r.label,
      sizeBytes: r.sizeBytes,
      sha256: r.sha256,
      createdBy: r.createdBy,
      createdAt: r.createdAt.toISOString(),
      helperOffline: true,
    })),
  };
}

export async function createBackup(
  label: string | undefined,
  userId: string
): Promise<{ success: boolean; backup?: BackupMeta; error?: string }> {
  const result = await callHelper('backup.create', { label }, { timeoutMs: BACKUP_CREATE_TIMEOUT_MS });
  if (!result.success) {
    return { success: false, error: result.error };
  }

  const data = result.data as {
    id: string;
    filename: string;
    sizeBytes: number;
    sha256: string;
    createdAt: string;
  };

  const db = getDb();
  await db.insert(backupMetadata).values({
    id: data.id,
    filename: data.filename,
    label: label ?? null,
    sizeBytes: data.sizeBytes,
    sha256: data.sha256,
    createdBy: userId,
  });

  return {
    success: true,
    backup: {
      id: data.id,
      filename: data.filename,
      label: label ?? null,
      sizeBytes: data.sizeBytes,
      sha256: data.sha256,
      createdBy: userId,
      createdAt: data.createdAt,
    },
  };
}

/**
 * List backups using the helper filesystem as the source of truth.
 *
 * The helper's backup.list operation scans the backup directory on disk
 * and returns all .tar.gz files with their metadata (filename, sizeBytes, createdAt).
 *
 * We then merge optional DB metadata (id, label, sha256, createdBy) on top.
 * Backups that exist on disk but not in the DB are still shown (with limited metadata).
 * Backups that exist in the DB but not on disk are excluded (they were deleted outside the panel).
 */
export async function listBackups(): Promise<ListBackupsResult> {
  // Step 1: Get the real files from the filesystem via helper
  let fsResult;
  try {
    fsResult = await callHelper('backup.list');
  } catch {
    return listBackupsFromDbFallback();
  }

  if (!fsResult.success) {
    // Fallback: if helper is unreachable or unavailable, fall back to DB-only listing.
    // Entries are flagged `helperOffline: true` so the UI can disable restore
    // and delete — we can't verify the file exists on disk or act on it until
    // the helper comes back.
    return listBackupsFromDbFallback();
  }

  const parsedDiskFiles = HelperBackupListDataSchema.parse(
    Array.isArray(fsResult.data) ? { backups: fsResult.data } : fsResult.data
  );
  const diskFiles: HelperBackupFile[] = parsedDiskFiles.backups;

  if (diskFiles.length === 0) {
    return { backups: [], helperOffline: false };
  }

  // Step 2: Fetch DB metadata for known filenames
  const db = getDb();
  const filenames = diskFiles.map((f) => f.filename);
  const dbRows = await db
    .select()
    .from(backupMetadata)
    .where(inArray(backupMetadata.filename, filenames));

  // Build a lookup map: filename → DB row
  const dbMap = new Map<string, typeof dbRows[number]>();
  for (const row of dbRows) {
    dbMap.set(row.filename, row);
  }

  // Step 3: Merge — disk is source of truth, DB enriches
  const backups: BackupMeta[] = diskFiles.map((diskFile) => {
    const dbRow = dbMap.get(diskFile.filename);

    if (dbRow) {
      // Known backup: use DB metadata enriched with disk size/date
      return {
        id: dbRow.id,
        filename: diskFile.filename,
        label: dbRow.label,
        sizeBytes: diskFile.sizeBytes,
        sha256: dbRow.sha256,
        createdBy: dbRow.createdBy,
        createdAt: diskFile.createdAt,
      };
    }

    // Unknown backup (created outside panel or DB was lost):
    // show it with limited metadata
    return {
      id: diskFile.filename, // use filename as pseudo-ID
      filename: diskFile.filename,
      label: null,
      sizeBytes: diskFile.sizeBytes,
      sha256: '',
      createdBy: null,
      createdAt: diskFile.createdAt,
    };
  });

  // Sort by createdAt descending
  backups.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

  return { backups, helperOffline: false };
}

export async function restoreBackup(
  backupId: string
): Promise<{ success: boolean; safetyBackup?: string; error?: string }> {
  // Try to find the backup by ID in DB first
  const db = getDb();
  const [dbBackup] = await db
    .select()
    .from(backupMetadata)
    .where(eq(backupMetadata.id, backupId))
    .limit(1);

  let filename: string;

  if (dbBackup) {
    filename = dbBackup.filename;
  } else {
    // backupId might be a filename (for disk-only backups without DB metadata)
    // Validate it looks like a safe backup filename
    if (!/^[a-zA-Z0-9_\-\.]+\.tar\.gz$/.test(backupId)) {
      return { success: false, error: 'Backup not found' };
    }
    filename = backupId;
  }

  // Verify archive integrity against the recorded hash before touching the worlds
  // directory. Catches on-disk corruption and tampering between create and restore.
  // Disk-only backups (no DB record) have no recorded hash and are allowed through.
  if (dbBackup && dbBackup.sha256) {
    const hashResult = await callHelper('backup.hash', { filename }, { timeoutMs: BACKUP_HASH_TIMEOUT_MS });
    if (!hashResult.success) {
      return { success: false, error: `Integrity check failed: ${hashResult.error ?? 'hash unavailable'}` };
    }
    const currentHash = (hashResult.data as { sha256?: string } | undefined)?.sha256;
    if (!currentHash || currentHash !== dbBackup.sha256) {
      return {
        success: false,
        error: 'Backup integrity check failed: SHA256 mismatch. File may be corrupted or tampered with.',
      };
    }
  }

  const result = await callHelper('backup.restore', { filename }, { timeoutMs: BACKUP_RESTORE_TIMEOUT_MS });
  if (!result.success) {
    return { success: false, error: result.error };
  }

  const data = result.data as { safetyBackup?: string };
  return { success: true, safetyBackup: data.safetyBackup };
}

export async function deleteBackup(
  backupId: string
): Promise<{ success: boolean; error?: string }> {
  const db = getDb();
  const [dbBackup] = await db
    .select()
    .from(backupMetadata)
    .where(eq(backupMetadata.id, backupId))
    .limit(1);

  let filename: string;

  if (dbBackup) {
    filename = dbBackup.filename;
  } else {
    // backupId might be a filename (for disk-only backups)
    if (!/^[a-zA-Z0-9_\-\.]+\.tar\.gz$/.test(backupId)) {
      return { success: false, error: 'Backup not found' };
    }
    filename = backupId;
  }

  const result = await callHelper('backup.delete', { filename });
  if (!result.success) {
    return { success: false, error: result.error };
  }

  // Clean up DB metadata if it exists
  if (dbBackup) {
    await db.delete(backupMetadata).where(eq(backupMetadata.id, backupId));
  }

  return { success: true };
}
