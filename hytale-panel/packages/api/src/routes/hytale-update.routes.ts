import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth } from '../middleware/require-auth';
import { requireRole } from '../middleware/require-role';
import { logAudit } from '../services/audit.service';
import * as hytaleUpdate from '../services/hytale-update.service';

const JobParamsSchema = z.object({ jobId: z.string().uuid() });
const LogsQuerySchema = z.object({ cursor: z.coerce.number().int().min(0).max(10_485_760).optional() });

type UpdateAction = 'check' | 'download' | 'apply' | 'update-now' | 'cancel';

function auditAction(action: UpdateAction): string {
  return `hytale.update_${action.replace('-', '_')}`;
}

async function startAction(
  request: { currentUser?: { id: string }; ip: string },
  reply: { status: (code: number) => { send: (payload: unknown) => unknown }; send: (payload: unknown) => unknown },
  action: UpdateAction,
) {
  const result = await hytaleUpdate.startHytaleUpdateJob(action);
  await logAudit({
    userId: request.currentUser!.id,
    action: auditAction(action),
    ipAddress: request.ip,
    success: result.success,
    details: result.success ? { jobId: result.jobId } : { error: result.error },
  });

  if (!result.success) {
    return reply.status(409).send({ success: false, error: result.error });
  }
  return reply.status(202).send({ success: true, data: { jobId: result.jobId } });
}

export async function hytaleUpdateRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get(
    '/api/hytale-updates/status',
    { preHandler: [requireAuth, requireRole('admin')] },
    async (_request, reply) => reply.send({ success: true, data: hytaleUpdate.getHytaleUpdateOverview() }),
  );

  for (const [path, action] of [
    ['/api/hytale-updates/check', 'check'],
    ['/api/hytale-updates/download', 'download'],
    ['/api/hytale-updates/apply', 'apply'],
    ['/api/hytale-updates/update-now', 'update-now'],
    ['/api/hytale-updates/cancel', 'cancel'],
  ] as const) {
    fastify.post(
      path,
      { preHandler: [requireAuth, requireRole('admin')] },
      async (request, reply) => startAction(request, reply, action),
    );
  }

  fastify.get(
    '/api/hytale-updates/jobs/latest',
    { preHandler: [requireAuth, requireRole('admin')] },
    async (_request, reply) => reply.send({ success: true, data: hytaleUpdate.latestHytaleUpdateJob() }),
  );

  fastify.get(
    '/api/hytale-updates/jobs/:jobId',
    { preHandler: [requireAuth, requireRole('admin')] },
    async (request, reply) => {
      const params = JobParamsSchema.parse(request.params);
      const status = hytaleUpdate.readHytaleUpdateJobStatus(params.jobId);
      if (!status) {
        return reply.status(404).send({ success: false, error: 'Job not found' });
      }
      return reply.send({ success: true, data: status });
    },
  );

  fastify.get(
    '/api/hytale-updates/jobs/:jobId/logs',
    { preHandler: [requireAuth, requireRole('admin')] },
    async (request, reply) => {
      const params = JobParamsSchema.parse(request.params);
      const query = LogsQuerySchema.parse(request.query ?? {});
      const logs = hytaleUpdate.readHytaleUpdateJobLogs(params.jobId, query.cursor ?? 0);
      if (!logs) {
        return reply.status(404).send({ success: false, error: 'Job not found' });
      }
      return reply.send({ success: true, data: logs });
    },
  );
}
