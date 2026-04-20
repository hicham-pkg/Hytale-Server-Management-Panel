import type { FastifyInstance } from 'fastify';
import { BackupIdentifierSchema, CreateBackupSchema } from '@hytale-panel/shared';
import * as backupService from '../services/backup.service';
import { logAudit } from '../services/audit.service';
import { requireAuth } from '../middleware/require-auth';
import { requireRole } from '../middleware/require-role';
import { isHelperUnavailableError } from '../services/helper-client';

export async function backupRoutes(fastify: FastifyInstance): Promise<void> {
  const sendHelperDegraded = (reply: { status: (code: number) => { send: (payload: unknown) => unknown } }, err: unknown) =>
    reply
      .status(isHelperUnavailableError(err) ? 503 : 502)
      .send({
        success: false,
        error: isHelperUnavailableError(err)
          ? 'Helper service unavailable'
          : (err as Error).message || 'Backup operation failed',
        data: {
          degraded: true,
          dependency: 'helper',
        },
      });

  fastify.get(
    '/api/backups',
    { preHandler: [requireAuth] },
    async (_request, reply) => {
      try {
        const result = await backupService.listBackups();
        return reply.send({ success: true, data: { backups: result.backups, helperOffline: result.helperOffline } });
      } catch (err) {
        return sendHelperDegraded(reply, err);
      }
    }
  );

  fastify.post(
    '/api/backups/create',
    { preHandler: [requireAuth, requireRole('admin')] },
    async (request, reply) => {
      const body = CreateBackupSchema.parse(request.body ?? {});
      let result;
      try {
        result = await backupService.createBackup(body.label, request.currentUser!.id);
      } catch (err) {
        return sendHelperDegraded(reply, err);
      }

      await logAudit({
        userId: request.currentUser!.id,
        action: 'backup.create',
        target: result.backup?.filename,
        ipAddress: request.ip,
        success: result.success,
        details: { label: body.label, sha256: result.backup?.sha256 },
      });

      if (!result.success) {
        return reply.status(500).send({ success: false, error: result.error });
      }

      return reply.send({ success: true, data: { backup: result.backup } });
    }
  );

  fastify.post(
    '/api/backups/:id/restore',
    { preHandler: [requireAuth, requireRole('admin')] },
    async (request, reply) => {
      const params = { id: BackupIdentifierSchema.parse((request.params as { id: string }).id) };
      let result;
      try {
        result = await backupService.restoreBackup(params.id);
      } catch (err) {
        return sendHelperDegraded(reply, err);
      }

      await logAudit({
        userId: request.currentUser!.id,
        action: 'backup.restore',
        target: params.id,
        ipAddress: request.ip,
        success: result.success,
        details: { safetyBackup: result.safetyBackup },
      });

      if (!result.success) {
        return reply.status(400).send({ success: false, error: result.error });
      }

      return reply.send({
        success: true,
        data: { message: 'Backup restored successfully', safetyBackup: result.safetyBackup },
      });
    }
  );

  fastify.delete(
    '/api/backups/:id',
    { preHandler: [requireAuth, requireRole('admin')] },
    async (request, reply) => {
      const params = { id: BackupIdentifierSchema.parse((request.params as { id: string }).id) };
      let result;
      try {
        result = await backupService.deleteBackup(params.id);
      } catch (err) {
        return sendHelperDegraded(reply, err);
      }

      await logAudit({
        userId: request.currentUser!.id,
        action: 'backup.delete',
        target: params.id,
        ipAddress: request.ip,
        success: result.success,
      });

      if (!result.success) {
        return reply.status(400).send({ success: false, error: result.error });
      }

      return reply.send({ success: true });
    }
  );
}
