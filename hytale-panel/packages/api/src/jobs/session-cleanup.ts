import * as cron from 'node-cron';
import { lt, or } from 'drizzle-orm';
import { getDb, schema } from '../db';
import { getConfig } from '../config';

const { sessions } = schema;

let task: cron.ScheduledTask | null = null;

export function startSessionCleanup(): void {
  // Run every 15 minutes
  task = cron.schedule('*/15 * * * *', async () => {
    try {
      const db = getDb();
      const config = getConfig();
      const now = new Date();
      // Primary: expiresAt in the past. Belt-and-suspenders: anything older than
      // the absolute max session age, in case a row somehow has a future or null
      // expiresAt and would otherwise linger forever.
      const absoluteCutoff = new Date(now.getTime() - config.sessionMaxAgeHours * 3600_000);
      await db
        .delete(sessions)
        .where(or(lt(sessions.expiresAt, now), lt(sessions.createdAt, absoluteCutoff)));
    } catch (err) {
      console.error('[SessionCleanup] Error:', err);
    }
  });

  console.log('[SessionCleanup] Started (every 15 minutes)');
}

export function stopSessionCleanup(): void {
  if (task) {
    task.stop();
    task = null;
  }
}