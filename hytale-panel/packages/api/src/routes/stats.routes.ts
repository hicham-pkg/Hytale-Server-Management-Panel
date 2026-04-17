import type { FastifyInstance } from 'fastify';
import * as statsService from '../services/stats.service';
import { requireAuth } from '../middleware/require-auth';

export async function statsRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get(
    '/api/stats/system',
    { preHandler: [requireAuth] },
    async (_request, reply) => {
      const stats = await statsService.getSystemStats();
      return reply.send({ success: true, data: stats });
    }
  );

  fastify.get(
    '/api/stats/process',
    { preHandler: [requireAuth] },
    async (_request, reply) => {
      const stats = await statsService.getProcessStats();
      return reply.send({ success: true, data: stats });
    }
  );
}