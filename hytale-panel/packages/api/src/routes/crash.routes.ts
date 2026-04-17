import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { UUID_REGEX } from '@hytale-panel/shared';
import * as crashService from '../services/crash.service';
import { logAudit } from '../services/audit.service';
import { requireAuth } from '../middleware/require-auth';
import { requireRole } from '../middleware/require-role';

export async function crashRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get(
    '/api/crashes',
    { preHandler: [requireAuth] },
    async (request, reply) => {
      const query = z.object({
        page: z.coerce.number().int().min(1).default(1),
        limit: z.coerce.number().int().min(1).max(200).default(50),
        status: z.enum(['active', 'historical', 'archived', 'all']).default('all'),
      }).parse(request.query);

      const result = await crashService.queryCrashEvents(query);
      return reply.send({ success: true, data: result });
    }
  );

  fastify.get(
    '/api/crashes/:id',
    { preHandler: [requireAuth] },
    async (request, reply) => {
      const params = z.object({ id: z.string().regex(UUID_REGEX) }).parse(request.params);
      const event = await crashService.getCrashEvent(params.id);

      if (!event) {
        return reply.status(404).send({ success: false, error: 'Crash event not found' });
      }

      return reply.send({ success: true, data: event });
    }
  );

  fastify.post(
    '/api/crashes/archive-historical',
    { preHandler: [requireAuth, requireRole('admin')] },
    async (request, reply) => {
      const result = await crashService.archiveHistoricalCrashEvents(request.currentUser!.id);

      await logAudit({
        userId: request.currentUser!.id,
        action: 'crash.archive_historical',
        ipAddress: request.ip,
        success: result.success,
        details: { archivedCount: result.archivedCount },
      });

      return reply.send({
        success: true,
        data: { archivedCount: result.archivedCount },
      });
    }
  );

  fastify.post(
    '/api/crashes/:id/archive',
    { preHandler: [requireAuth, requireRole('admin')] },
    async (request, reply) => {
      const params = z.object({ id: z.string().regex(UUID_REGEX) }).parse(request.params);
      const result = await crashService.archiveCrashEvent(params.id, request.currentUser!.id);

      await logAudit({
        userId: request.currentUser!.id,
        action: 'crash.archive',
        target: params.id,
        ipAddress: request.ip,
        success: result.success,
        details: { alreadyArchived: result.alreadyArchived ?? false },
      });

      if (!result.success) {
        return reply.status(404).send({ success: false, error: result.error });
      }

      return reply.send({
        success: true,
        data: { archived: true, alreadyArchived: result.alreadyArchived ?? false },
      });
    }
  );
}
