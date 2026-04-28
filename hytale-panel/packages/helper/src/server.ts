import Fastify from 'fastify';
import * as fs from 'fs';
import { z } from 'zod';
import {
  HELPER_OPERATIONS,
  BACKUP_FILENAME_REGEX,
  BACKUP_LABEL_REGEX,
  UUID_REGEX,
  COMMAND_CHAR_ALLOWLIST,
  MAX_COMMAND_LENGTH,
} from '@hytale-panel/shared';
import type { HelperOperation } from '@hytale-panel/shared';
import { validateRequest } from './auth';
import { loadConfig, type HelperConfig } from './config';
import { startServer, stopServer, restartServer, getServerStatus } from './handlers/server-control';
import { sendCommand, capturePane } from './handlers/console';
import { readLogs } from './handlers/logs';
import { readWhitelist, writeWhitelist, readBans, writeBans } from './handlers/files';
import {
  createBackup,
  listBackups,
  restoreBackup,
  deleteBackup,
  hashBackup,
  getBackupOperationStatus,
  reconcileRunningBackupOperations,
} from './handlers/backup';
import {
  backupMods,
  disableMod,
  enableMod,
  installStagedMod,
  listMods,
  removeMod,
  restartAndVerifyServer,
  rollbackModsBackup,
} from './handlers/mods';
import { getSystemStats, getProcessStats } from './handlers/stats';

// Cap on the total /rpc request body. All legitimate helper payloads fit
// well under 64 KiB — even a full whitelist of 1000 UUIDs is ~40 KiB
// (H6). Fastify rejects oversize bodies before parsing.
const MAX_BODY_BYTES = 64 * 1024;

const RequestSchema = z.object({
  operation: z.enum(HELPER_OPERATIONS),
  params: z.record(z.unknown()).default({}),
  timestamp: z.number(),
  nonce: z.string().min(16).max(64),
  signature: z.string().length(64),
});

export async function createHelperServer() {
  const config = loadConfig();

  // Best-effort startup reconciliation so stale "running" operations from a
  // previous helper instance can be promoted to a terminal state.
  try {
    await reconcileRunningBackupOperations(config);
  } catch (err) {
    console.error('[helper/backup] startup reconciliation failed:', err);
  }

  // Remove stale socket file
  try {
    const existing = fs.lstatSync(config.socketPath);
    if (!existing.isSocket()) {
      throw new Error(`Refusing to replace non-socket file at ${config.socketPath}`);
    }
    fs.unlinkSync(config.socketPath);
  } catch (err) {
    const nodeErr = err as NodeJS.ErrnoException;
    if (nodeErr.code !== 'ENOENT') {
      throw err;
    }
    // Socket doesn't exist yet
  }

  const fastify = Fastify({
    bodyLimit: MAX_BODY_BYTES,
    logger: {
      level: 'info',
      // Use plain JSON logging — no pino-pretty dependency needed in production.
      // For human-readable dev logs, pipe output through pino-pretty:
      //   node dist/index.js | npx pino-pretty
    },
  });

  fastify.post('/rpc', async (request, reply) => {
    try {
      const body = RequestSchema.parse(request.body);

      // Validate HMAC signature
      const authResult = validateRequest(
        config,
        body.operation,
        body.params,
        body.timestamp,
        body.nonce,
        body.signature
      );

      if (!authResult.valid) {
        fastify.log.warn(`Auth failed for ${body.operation}: ${authResult.error}`);
        return reply.status(403).send({ success: false, error: 'Authentication failed' });
      }

      fastify.log.info(`Executing operation: ${body.operation}`);
      const result = await executeOperation(config, body.operation, body.params);
      return reply.status(result.success ? 200 : 409).send(result);
    } catch (err) {
      if (err instanceof z.ZodError) {
        return reply.status(400).send({ success: false, error: 'Invalid request format' });
      }
      fastify.log.error(err, 'RPC handler error');
      return reply.status(500).send({ success: false, error: 'Internal helper error' });
    }
  });

  // Health check (no auth required — local socket only)
  fastify.get('/health', async () => ({ status: 'ok' }));

  await fastify.listen({ path: config.socketPath });

  if (
    typeof process.getuid === 'function' &&
    typeof process.getgid === 'function' &&
    process.getuid() === 0
  ) {
    fs.chownSync(config.socketPath, process.getuid(), process.getgid());
  }

  // Set socket permissions so only the panel user can connect
  fs.chmodSync(config.socketPath, 0o660);

  fastify.log.info(`Helper service listening on ${config.socketPath}`);
  return fastify;
}

async function executeOperation(
  config: HelperConfig,
  operation: HelperOperation,
  params: Record<string, unknown>
): Promise<{ success: boolean; data?: unknown; error?: string }> {
  switch (operation) {
    case 'helper.ping': {
      return {
        success: true,
        data: {
          pong: true,
          serverTime: new Date().toISOString(),
        },
      };
    }
    case 'server.start': {
      const result = await startServer(config);
      return { success: result.success, data: result, error: result.success ? undefined : result.message };
    }
    case 'server.stop': {
      const result = await stopServer(config);
      return { success: result.success, data: result, error: result.success ? undefined : result.message };
    }
    case 'server.restart': {
      const result = await restartServer(config);
      return { success: result.success, data: result, error: result.success ? undefined : result.message };
    }
    case 'server.status': {
      const result = await getServerStatus(config);
      return { success: true, data: result };
    }
    case 'server.sendCommand': {
      const command = z
        .string()
        .max(MAX_COMMAND_LENGTH)
        .regex(COMMAND_CHAR_ALLOWLIST)
        .parse(params.command);
      const result = await sendCommand(config, command);
      return { success: result.success, data: result, error: result.success ? undefined : result.message };
    }
    case 'logs.read': {
      const lines = z.number().int().min(1).max(1000).parse(params.lines ?? 100);
      const since = params.since ? z.string().max(64).parse(params.since) : undefined;
      const result = await readLogs(config, lines, since);
      return { success: result.success, data: { lines: result.lines }, error: result.error };
    }
    case 'console.capturePane': {
      const lines = z.number().int().min(1).max(500).parse(params.lines ?? 50);
      const result = await capturePane(config, lines);
      return { success: result.success, data: { lines: result.lines }, error: result.error };
    }
    case 'whitelist.read': {
      const result = await readWhitelist(config);
      return { success: result.success, data: { enabled: result.enabled, list: result.list }, error: result.error };
    }
    case 'whitelist.write': {
      const enabled = z.boolean().parse(params.enabled ?? false);
      const list = z.array(z.string().max(64)).max(1000).parse(params.list ?? []);
      const result = await writeWhitelist(config, enabled, list);
      return { success: result.success, error: result.error };
    }
    case 'bans.read': {
      const result = await readBans(config);
      return { success: result.success, data: { entries: result.entries }, error: result.error };
    }
    case 'bans.write': {
      const entries = z
        .array(
          z.object({
            name: z.string().max(64),
            reason: z.string().max(500).optional(),
            bannedAt: z.string().max(64).optional(),
          })
        )
        .max(1000)
        .parse(params.entries);
      const result = await writeBans(config, entries);
      return { success: result.success, error: result.error };
    }
    case 'backup.create': {
      const label = params.label
        ? z.string().regex(BACKUP_LABEL_REGEX).parse(params.label)
        : undefined;
      const operationId = params.operationId
        ? z.string().regex(UUID_REGEX).parse(params.operationId)
        : undefined;
      const result = await createBackup(config, label, operationId);
      return { success: result.success, data: result.backup, error: result.error };
    }
    case 'backup.list': {
      const result = await listBackups(config);
      return { success: result.success, data: { backups: result.backups }, error: result.error };
    }
    case 'backup.restore': {
      const filename = z.string().regex(BACKUP_FILENAME_REGEX).parse(params.filename);
      const operationId = params.operationId
        ? z.string().regex(UUID_REGEX).parse(params.operationId)
        : undefined;
      const result = await restoreBackup(config, filename, operationId);
      return { success: result.success, data: { safetyBackup: result.safetyBackup }, error: result.error };
    }
    case 'backup.operationStatus': {
      const operationId = z.string().regex(UUID_REGEX).parse(params.operationId);
      const result = await getBackupOperationStatus(config, operationId);
      return { success: result.success, data: { found: result.found, operation: result.operation }, error: result.error };
    }
    case 'backup.delete': {
      const filename = z.string().regex(BACKUP_FILENAME_REGEX).parse(params.filename);
      const result = await deleteBackup(config, filename);
      return { success: result.success, error: result.error };
    }
    case 'backup.hash': {
      const filename = z.string().regex(BACKUP_FILENAME_REGEX).parse(params.filename);
      const result = await hashBackup(config, filename);
      return { success: result.success, data: { sha256: result.sha256 }, error: result.error };
    }
    case 'mods.list': {
      return runModRpc(() => listMods(config));
    }
    case 'mods.installStaged': {
      const stagedId = z.string().regex(UUID_REGEX).parse(params.stagedId);
      const sanitizedName = z.string().max(140).parse(params.sanitizedName);
      const sha256 = z.string().regex(/^[a-f0-9]{64}$/i).parse(params.sha256);
      const replace = z.boolean().parse(params.replace ?? false);
      return runModRpc(() => installStagedMod(config, stagedId, sanitizedName, sha256, replace));
    }
    case 'mods.disable': {
      const name = z.string().max(140).parse(params.name);
      return runModRpc(async () => ({ ...(await disableMod(config, name)), message: 'Mod disabled' }));
    }
    case 'mods.enable': {
      const name = z.string().max(140).parse(params.name);
      return runModRpc(async () => ({ ...(await enableMod(config, name)), message: 'Mod enabled' }));
    }
    case 'mods.remove': {
      const name = z.string().max(140).parse(params.name);
      return runModRpc(async () => ({ ...(await removeMod(config, name)), message: 'Mod removed' }));
    }
    case 'mods.backup': {
      return runModRpc(async () => ({ ...(await backupMods(config, 'manual')), message: 'Mods backup created' }));
    }
    case 'mods.rollback': {
      const backupName = params.backupName ? z.string().max(200).parse(params.backupName) : undefined;
      return runModRpc(async () => ({ ...(await rollbackModsBackup(config, backupName)), message: 'Mods backup restored' }));
    }
    case 'mods.restartVerify': {
      const autoRollback = z.boolean().parse(params.autoRollback ?? false);
      try {
        const result = await restartAndVerifyServer(config, autoRollback);
        return { success: result.startupOk, data: result, error: result.startupOk ? undefined : result.message };
      } catch (err) {
        return { success: false, error: err instanceof Error && !err.message.includes('/') ? err.message : 'Mod operation failed' };
      }
    }
    case 'stats.system': {
      const result = await getSystemStats();
      return { success: result.success, data: result.stats, error: result.error };
    }
    case 'stats.process': {
      const result = await getProcessStats(config);
      return { success: result.success, data: result.stats, error: result.error };
    }
    default:
      return { success: false, error: `Unknown operation: ${operation}` };
  }
}

async function runModRpc<T>(fn: () => Promise<T>): Promise<{ success: boolean; data?: T; error?: string }> {
  try {
    return { success: true, data: await fn() };
  } catch (err) {
    const message = err instanceof Error && err.message && !err.message.includes('/')
      ? err.message
      : 'Mod operation failed';
    return { success: false, error: message };
  }
}
