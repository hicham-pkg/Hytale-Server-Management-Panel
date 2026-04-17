import { z } from 'zod';

/**
 * Panel settings schema — v1.
 *
 * Only safe operational settings are exposed through the API/UI.
 * Server paths (HYTALE_ROOT, WHITELIST_PATH, BANS_PATH, BACKUP_PATH)
 * are configured exclusively via the helper service's .env file
 * and are NOT editable through the web panel for security reasons.
 */
export const UpdateSettingsSchema = z.object({
  sessionTimeoutHours: z.number().int().min(1).max(72).optional(),
  logRetentionDays: z.number().int().min(1).max(365).optional(),
  enableScheduledBackups: z.boolean().optional(),
  scheduledBackupCron: z.string().max(100).optional(),
});

export type UpdateSettingsInput = z.infer<typeof UpdateSettingsSchema>;