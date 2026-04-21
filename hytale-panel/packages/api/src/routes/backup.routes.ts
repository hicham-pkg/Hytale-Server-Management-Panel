import type { FastifyInstance } from 'fastify';
import { BackupIdentifierSchema, CreateBackupSchema } from '@hytale-panel/shared';
import * as backupService from '../services/backup.service';
import * as backupJobService from '../services/backup-job.service';
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
      const job = await backupJobService.enqueueCreateBackupJob(body.label, request.currentUser!.id);

      await logAudit({
        userId: request.currentUser!.id,
        action: 'backup.create.queued',
        target: job.id,
        ipAddress: request.ip,
        success: true,
        details: { label: body.label ?? null },
      });

      return reply.status(202).send({ success: true, data: { job } });
    }
  );

  fastify.post(
    '/api/backups/:id/restore',
    { preHandler: [requireAuth, requireRole('admin')] },
    async (request, reply) => {
      const params = { id: BackupIdentifierSchema.parse((request.params as { id: string }).id) };
      const job = await backupJobService.enqueueRestoreBackupJob(params.id, request.currentUser!.id);

      await logAudit({
        userId: request.currentUser!.id,
        action: 'backup.restore.queued',
        target: job.id,
        ipAddress: request.ip,
        success: true,
        details: { backupId: params.id },
      });

      return reply.status(202).send({ success: true, data: { job } });
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
