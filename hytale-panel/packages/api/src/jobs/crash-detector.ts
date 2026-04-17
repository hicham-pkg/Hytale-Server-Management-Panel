import * as cron from 'node-cron';
import { scanForCrashes } from '../services/crash.service';

let task: cron.ScheduledTask | null = null;

export function startCrashDetector(): void {
  // Run every 5 minutes
  task = cron.schedule('*/5 * * * *', async () => {
    try {
      const count = await scanForCrashes();
      if (count > 0) {
        console.log(`[CrashDetector] Detected ${count} new crash event(s)`);
      }
    } catch (err) {
      console.error('[CrashDetector] Error scanning for crashes:', err);
    }
  });

  console.log('[CrashDetector] Started (every 5 minutes)');
}

export function stopCrashDetector(): void {
  if (task) {
    task.stop();
    task = null;
  }
}