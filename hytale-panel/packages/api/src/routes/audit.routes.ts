import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import * as auditService from '../services/audit.service';
import { requireAuth } from '../middleware/require-auth';
import { requireRole } from '../middleware/require-role';

export async function auditRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get(
    '/api/audit-logs',
    { preHandler: [requireAuth, requireRole('admin')] },
    async (request, reply) => {
      const query = z.object({
        page: z.coerce.number().int().min(1).default(1),
        limit: z.coerce.number().int().min(1).max(200).default(50),
        userId: z.string().uuid().optional(),
        action: z.string().max(100).optional(),
        since: z.string().optional(),
        until: z.string().optional(),
      }).parse(request.query);

      const result = await auditService.queryAuditLogs(query);
      return reply.send({ success: true, data: result });
    }
  );

  fastify.get(
    '/api/audit-logs/export',
    { preHandler: [requireAuth, requireRole('admin')] },
    async (_request, reply) => {
      const logs = await auditService.exportAuditLogs();
      reply.header('Content-Type', 'application/json');
      reply.header('Content-Disposition', 'attachment; filename="audit-logs.json"');
      return reply.send(logs);
    }
  );
}