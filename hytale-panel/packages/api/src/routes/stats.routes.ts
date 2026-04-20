import type { FastifyInstance } from 'fastify';
import * as statsService from '../services/stats.service';
import { requireAuth } from '../middleware/require-auth';
import { isHelperUnavailableError } from '../services/helper-client';

export async function statsRoutes(fastify: FastifyInstance): Promise<void> {
  const sendHelperDegraded = (reply: { status: (code: number) => { send: (payload: unknown) => unknown } }, err: unknown) =>
    reply
      .status(isHelperUnavailableError(err) ? 503 : 502)
      .send({
        success: false,
        error: isHelperUnavailableError(err)
          ? 'Helper service unavailable'
          : (err as Error).message || 'Helper stats request failed',
        data: {
          degraded: true,
          dependency: 'helper',
        },
      });

  fastify.get(
    '/api/stats/system',
    { preHandler: [requireAuth] },
    async (_request, reply): Promise<void> => {
      try {
        const stats = await statsService.getSystemStats();
        await reply.send({ success: true, data: stats });
      } catch (err) {
        await sendHelperDegraded(reply, err);
      }
    }
  );

  fastify.get(
    '/api/stats/process',
    { preHandler: [requireAuth] },
    async (_request, reply): Promise<void> => {
      try {
        const stats = await statsService.getProcessStats();
        await reply.send({ success: true, data: stats });
      } catch (err) {
        await sendHelperDegraded(reply, err);
      }
    }
  );
}
