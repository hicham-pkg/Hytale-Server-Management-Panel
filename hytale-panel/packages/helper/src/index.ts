import { createHelperServer } from './server';

async function main() {
  try {
    const server = await createHelperServer();

    const shutdown = async () => {
      console.log('Shutting down helper service...');
      await server.close();
      process.exit(0);
    };

    process.on('SIGTERM', shutdown);
    process.on('SIGINT', shutdown);

    console.log('Hytale helper service started successfully');
  } catch (err) {
    console.error('Failed to start helper service:', err);
    process.exit(1);
  }
}

main();