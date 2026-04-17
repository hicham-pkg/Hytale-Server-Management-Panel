import type { FastifyInstance } from 'fastify';
import { AddBanSchema, RemoveBanSchema } from '@hytale-panel/shared';
import * as banService from '../services/ban.service';
import * as serverService from '../services/server.service';
import { logAudit } from '../services/audit.service';
import { requireAuth } from '../middleware/require-auth';
import { requireRole } from '../middleware/require-role';

export async function banRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get(
    '/api/bans',
    { preHandler: [requireAuth] },
    async (_request, reply) => {
      const result = await banService.getBans();
      return reply.send({ success: result.success, data: { entries: result.entries } });
    }
  );

  fastify.post(
    '/api/bans/add',
    { preHandler: [requireAuth, requireRole('admin')] },
    async (request, reply) => {
      const body = AddBanSchema.parse(request.body);
      const status = await serverService.getServerStatus();
      const result = await banService.addBan(body.name, body.reason ?? '', status.running);

      await logAudit({
        userId: request.currentUser!.id,
        action: 'bans.add',
        target: body.name,
        ipAddress: request.ip,
        success: result.success,
        details: { reason: body.reason },
      });

      return reply.send({ success: result.success, data: { message: result.message } });
    }
  );

  fastify.post(
    '/api/bans/remove',
    { preHandler: [requireAuth, requireRole('admin')] },
    async (request, reply) => {
      const body = RemoveBanSchema.parse(request.body);
      const status = await serverService.getServerStatus();
      const result = await banService.removeBan(body.name, status.running);

      await logAudit({
        userId: request.currentUser!.id,
        action: 'bans.remove',
        target: body.name,
        ipAddress: request.ip,
        success: result.success,
      });

      return reply.send({ success: result.success, data: { message: result.message } });
    }
  );
}