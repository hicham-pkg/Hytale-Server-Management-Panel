import type { FastifyInstance } from 'fastify';
import * as serverService from '../services/server.service';
import { logAudit } from '../services/audit.service';
import { requireAuth } from '../middleware/require-auth';
import { requireRole } from '../middleware/require-role';
import { isHelperUnavailableError } from '../services/helper-client';

export async function serverRoutes(fastify: FastifyInstance): Promise<void> {
  const sendHelperDegraded = (reply: { status: (code: number) => { send: (payload: unknown) => unknown } }, err: unknown) =>
    reply
      .status(isHelperUnavailableError(err) ? 503 : 502)
      .send({
        success: false,
        error: isHelperUnavailableError(err)
          ? 'Helper service unavailable'
          : (err as Error).message || 'Helper request failed',
        data: {
          degraded: true,
          dependency: 'helper',
        },
      });

  fastify.get(
    '/api/server/status',
    { preHandler: [requireAuth] },
    async (_request, reply) => {
      try {
        const status = await serverService.getServerStatus({ strict: true });
        return reply.send({ success: true, data: status });
      } catch (err) {
        return sendHelperDegraded(reply, err);
      }
    }
  );

  fastify.post(
    '/api/server/start',
    { preHandler: [requireAuth, requireRole('admin')] },
    async (request, reply) => {
      let result;
      try {
        result = await serverService.startServer();
      } catch (err) {
        return sendHelperDegraded(reply, err);
      }

      await logAudit({
        userId: request.currentUser!.id,
        action: 'server.start',
        ipAddress: request.ip,
        success: result.success,
        details: { message: result.message },
      });

      return reply
        .status(result.success ? 200 : 409)
        .send({
          success: result.success,
          data: { message: result.message },
          error: result.success ? undefined : result.message,
        });
    }
  );

  fastify.post(
    '/api/server/stop',
    { preHandler: [requireAuth, requireRole('admin')] },
    async (request, reply) => {
      let result;
      try {
        result = await serverService.stopServer();
      } catch (err) {
        return sendHelperDegraded(reply, err);
      }

      await logAudit({
        userId: request.currentUser!.id,
        action: 'server.stop',
        ipAddress: request.ip,
        success: result.success,
        details: { message: result.message },
      });

      return reply
        .status(result.success ? 200 : 409)
        .send({
          success: result.success,
          data: { message: result.message },
          error: result.success ? undefined : result.message,
        });
    }
  );

  fastify.post(
    '/api/server/restart',
    { preHandler: [requireAuth, requireRole('admin')] },
    async (request, reply) => {
      let result;
      try {
        result = await serverService.restartServer();
      } catch (err) {
        return sendHelperDegraded(reply, err);
      }

      await logAudit({
        userId: request.currentUser!.id,
        action: 'server.restart',
        ipAddress: request.ip,
        success: result.success,
        details: { message: result.message },
      });

      return reply
        .status(result.success ? 200 : 409)
        .send({
          success: result.success,
          data: { message: result.message },
          error: result.success ? undefined : result.message,
        });
    }
  );
}
