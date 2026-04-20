import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import * as consoleService from '../services/console.service';
import { requireAuth } from '../middleware/require-auth';
import { isHelperUnavailableError } from '../services/helper-client';

export async function consoleRoutes(fastify: FastifyInstance): Promise<void> {
  const sendHelperDegraded = (reply: { status: (code: number) => { send: (payload: unknown) => unknown } }, err: unknown) =>
    reply
      .status(isHelperUnavailableError(err) ? 503 : 502)
      .send({
        success: false,
        error: isHelperUnavailableError(err)
          ? 'Helper service unavailable'
          : (err as Error).message || 'Helper console request failed',
        data: {
          degraded: true,
          dependency: 'helper',
        },
      });

  fastify.get(
    '/api/console/history',
    { preHandler: [requireAuth] },
    async (request, reply) => {
      const query = z.object({
        lines: z.coerce.number().int().min(1).max(500).default(50),
      }).parse(request.query);

      try {
        const result = await consoleService.captureConsoleOutput(query.lines);
        return reply.send({ success: result.success, data: { lines: result.lines }, error: result.error });
      } catch (err) {
        return sendHelperDegraded(reply, err);
      }
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

      try {
        const result = await consoleService.readLogs(query.lines, query.since);
        return reply.send({ success: result.success, data: { lines: result.lines }, error: result.error });
      } catch (err) {
        return sendHelperDegraded(reply, err);
      }
    }
  );
}
