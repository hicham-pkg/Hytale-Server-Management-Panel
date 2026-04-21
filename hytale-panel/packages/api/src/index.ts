import { buildApp } from './app';
import { getConfig } from './config';
import { startCrashDetector, stopCrashDetector } from './jobs/crash-detector';
import { startSessionCleanup, stopSessionCleanup } from './jobs/session-cleanup';
import { startRetentionCleanup, stopRetentionCleanup } from './jobs/retention-cleanup';
import { startBackupJobWorker, stopBackupJobWorker } from './services/backup-job.service';

async function main() {
  try {
    const config = getConfig();
    const app = await buildApp();

    // Start background jobs
    startCrashDetector();
    startSessionCleanup();
    startRetentionCleanup();
    startBackupJobWorker();

    await app.listen({ host: config.apiHost, port: config.apiPort });
    console.log(`Hytale Panel API listening on ${config.apiHost}:${config.apiPort}`);

    const shutdown = async () => {
      console.log('Shutting down...');
      stopCrashDetector();
      stopSessionCleanup();
      stopRetentionCleanup();
      stopBackupJobWorker();
      await app.close();
      process.exit(0);
    };

    process.on('SIGTERM', shutdown);
    process.on('SIGINT', shutdown);
  } catch (err) {
    console.error('Failed to start API server:', err);
    process.exit(1);
  }
}

main();
