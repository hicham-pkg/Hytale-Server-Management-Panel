import type { FastifyInstance } from 'fastify';
import { BackupIdentifierSchema, CreateBackupSchema } from '@hytale-panel/shared';
import * as backupService from '../services/backup.service';
import { logAudit } from '../services/audit.service';
import { requireAuth } from '../middleware/require-auth';
import { requireRole } from '../middleware/require-role';

export async function backupRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get(
    '/api/backups',
    { preHandler: [requireAuth] },
    async (_request, reply) => {
      const backups = await backupService.listBackups();
      return reply.send({ success: true, data: { backups } });
    }
  );

  fastify.post(
    '/api/backups/create',
    { preHandler: [requireAuth, requireRole('admin')] },
    async (request, reply) => {
      const body = CreateBackupSchema.parse(request.body ?? {});
      const result = await backupService.createBackup(body.label, request.currentUser!.id);

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
      const result = await backupService.restoreBackup(params.id);

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
      const result = await backupService.deleteBackup(params.id);

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
