import * as cron from 'node-cron';
import { lt } from 'drizzle-orm';
import { getDb, schema } from '../db';
import { getConfig } from '../config';

const { auditLogs, crashEvents } = schema;

let task: cron.ScheduledTask | null = null;

export function startRetentionCleanup(): void {
  const config = getConfig();

  // Daily at 03:00. Purges rows older than their configured retention window.
  task = cron.schedule('0 3 * * *', async () => {
    try {
      const db = getDb();
      const now = Date.now();
      const auditCutoff = new Date(now - config.auditLogRetentionDays * 86_400_000);
      const crashCutoff = new Date(now - config.crashLogRetentionDays * 86_400_000);

      const deletedAudit = await db
        .delete(auditLogs)
        .where(lt(auditLogs.createdAt, auditCutoff))
        .returning({ id: auditLogs.id });

      const deletedCrash = await db
        .delete(crashEvents)
        .where(lt(crashEvents.detectedAt, crashCutoff))
        .returning({ id: crashEvents.id });

      if (deletedAudit.length > 0 || deletedCrash.length > 0) {
        console.log(
          `[RetentionCleanup] Purged ${deletedAudit.length} audit_log(s) older than ` +
            `${config.auditLogRetentionDays}d and ${deletedCrash.length} crash_event(s) ` +
            `older than ${config.crashLogRetentionDays}d`
        );
      }
    } catch (err) {
      console.error('[RetentionCleanup] Error:', err);
    }
  });

  console.log(
    `[RetentionCleanup] Started (daily @ 03:00; audit ${config.auditLogRetentionDays}d, ` +
      `crash ${config.crashLogRetentionDays}d)`
  );
}

export function stopRetentionCleanup(): void {
  if (task) {
    task.stop();
    task = null;
  }
}
