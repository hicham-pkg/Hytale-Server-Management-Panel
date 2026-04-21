import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth } from '../middleware/require-auth';
import { requireRole } from '../middleware/require-role';
import * as backupJobService from '../services/backup-job.service';

const BackupJobIdSchema = z.string().uuid();
const BackupJobStatusSchema = z.enum(['queued', 'running', 'succeeded', 'failed', 'interrupted']);
const ListBackupJobsQuerySchema = z.object({
  status: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

function parseStatusFilter(raw: string | undefined) {
  if (!raw) {
    return undefined;
  }

  const parts = raw
    .split(',')
    .map((value) => value.trim())
    .filter((value) => value.length > 0);

  if (parts.length === 0) {
    return undefined;
  }

  return parts.map((value) => BackupJobStatusSchema.parse(value));
}

export async function backupJobRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get(
    '/api/backups/jobs/:id',
    { preHandler: [requireAuth, requireRole('admin')] },
    async (request, reply) => {
      const id = BackupJobIdSchema.parse((request.params as { id: string }).id);
      const job = await backupJobService.getBackupJob(id);

      if (!job) {
        return reply.status(404).send({ success: false, error: 'Backup job not found' });
      }

      return reply.send({ success: true, data: { job } });
    }
  );

  fastify.get(
    '/api/backups/jobs',
    { preHandler: [requireAuth, requireRole('admin')] },
    async (request, reply) => {
      const query = ListBackupJobsQuerySchema.parse(request.query ?? {});
      const statuses = parseStatusFilter(query.status);
      const jobs = await backupJobService.listBackupJobs({
        statuses,
        limit: query.limit,
      });

      return reply.send({ success: true, data: { jobs } });
    }
  );
}
