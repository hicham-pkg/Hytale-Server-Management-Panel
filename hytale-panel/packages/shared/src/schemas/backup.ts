import { z } from 'zod';
import { BACKUP_FILENAME_REGEX, BACKUP_LABEL_REGEX, UUID_REGEX } from '../constants';

export const CreateBackupSchema = z.object({
  label: z.string().regex(BACKUP_LABEL_REGEX).max(50).optional(),
});

export const BackupIdentifierSchema = z.string().refine(
  (value) => UUID_REGEX.test(value) || BACKUP_FILENAME_REGEX.test(value),
  'Invalid backup identifier'
);

export const RestoreBackupSchema = z.object({
  id: BackupIdentifierSchema,
});

export const DeleteBackupSchema = z.object({
  id: BackupIdentifierSchema,
});

export const BackupMetadataSchema = z.object({
  id: z.string().uuid(),
  filename: z.string(),
  label: z.string().nullable(),
  sizeBytes: z.number(),
  sha256: z.string(),
  createdBy: z.string().uuid().nullable(),
  createdAt: z.string(),
  helperOffline: z.boolean().optional(),
});

export const HelperBackupFileSchema = z.object({
  filename: z.string().regex(BACKUP_FILENAME_REGEX),
  sizeBytes: z.number(),
  createdAt: z.string(),
});

export const HelperBackupListDataSchema = z.object({
  backups: z.array(HelperBackupFileSchema),
});

export type CreateBackupInput = z.infer<typeof CreateBackupSchema>;
export type BackupMetadata = z.infer<typeof BackupMetadataSchema>;
export type HelperBackupFile = z.infer<typeof HelperBackupFileSchema>;
export type HelperBackupListData = z.infer<typeof HelperBackupListDataSchema>;
