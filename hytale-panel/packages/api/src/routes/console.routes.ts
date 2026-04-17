import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import * as consoleService from '../services/console.service';
import { requireAuth } from '../middleware/require-auth';

export async function consoleRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get(
    '/api/console/history',
    { preHandler: [requireAuth] },
    async (request, reply) => {
      const query = z.object({
        lines: z.coerce.number().int().min(1).max(500).default(50),
      }).parse(request.query);

      const result = await consoleService.captureConsoleOutput(query.lines);
      return reply.send({ success: result.success, data: { lines: result.lines }, error: result.error });
    }
  );

  fastify.get(
    '/api/console/logs',
    { preHandler: [requireAuth] },
    async (request, reply) => {
      const query = z.object({
        lines: z.coerce.number().int().min(1).max(1000).default(100),
        since: z.string().optional(),
      }).parse(request.query);

      const result = await consoleService.readLogs(query.lines, query.since);
      return reply.send({ success: result.success, data: { lines: result.lines }, error: result.error });
    }
  );
}