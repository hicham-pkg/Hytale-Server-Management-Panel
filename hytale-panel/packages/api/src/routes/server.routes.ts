import type { FastifyInstance } from 'fastify';
import * as serverService from '../services/server.service';
import { logAudit } from '../services/audit.service';
import { requireAuth } from '../middleware/require-auth';
import { requireRole } from '../middleware/require-role';

export async function serverRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get(
    '/api/server/status',
    { preHandler: [requireAuth] },
    async (_request, reply) => {
      try {
        const status = await serverService.getServerStatus();
        return reply.send({ success: true, data: status });
      } catch (err) {
        return reply.send({
          success: true,
          data: {
            running: false,
            pid: null,
            uptime: null,
            lastRestart: null,
            playerCount: null,
            serviceName: 'hytale-tmux.service',
            error: 'Helper service unavailable',
          },
        });
      }
    }
  );

  fastify.post(
    '/api/server/start',
    { preHandler: [requireAuth, requireRole('admin')] },
    async (request, reply) => {
      const result = await serverService.startServer();

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
      const result = await serverService.stopServer();

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
      const result = await serverService.restartServer();

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
