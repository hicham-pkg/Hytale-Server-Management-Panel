import type { FastifyInstance } from 'fastify';
import { AddBanSchema, RemoveBanSchema } from '@hytale-panel/shared';
import * as banService from '../services/ban.service';
import * as serverService from '../services/server.service';
import { logAudit } from '../services/audit.service';
import { requireAuth } from '../middleware/require-auth';
import { requireRole } from '../middleware/require-role';
import { isHelperUnavailableError } from '../services/helper-client';

export async function banRoutes(fastify: FastifyInstance): Promise<void> {
  const sendHelperDegraded = (reply: { status: (code: number) => { send: (payload: unknown) => unknown } }, err: unknown) =>
    reply
      .status(isHelperUnavailableError(err) ? 503 : 502)
      .send({
        success: false,
        error: isHelperUnavailableError(err)
          ? 'Helper service unavailable'
          : (err as Error).message || 'Unable to determine server state',
        data: {
          message: 'Unable to verify live server state',
          degraded: true,
          dependency: 'helper',
        },
      });

  fastify.get(
    '/api/bans',
    { preHandler: [requireAuth] },
    async (_request, reply) => {
      try {
        const result = await banService.getBans();
        if (!result.success) {
          return reply.status(409).send({
            success: false,
            error: result.error ?? 'Failed to read ban list',
            data: { entries: [] },
          });
        }
        return reply.send({ success: result.success, data: { entries: result.entries }, error: result.error });
      } catch (err) {
        return sendHelperDegraded(reply, err);
      }
    }
  );

  fastify.post(
    '/api/bans/add',
    { preHandler: [requireAuth, requireRole('admin')] },
    async (request, reply) => {
      const body = AddBanSchema.parse(request.body);
      let result;
      try {
        const status = await serverService.getServerStatus({ strict: true });
        result = await banService.addBan(body.name, body.reason ?? '', status.running);
      } catch (err) {
        return sendHelperDegraded(reply, err);
      }

      await logAudit({
        userId: request.currentUser!.id,
        action: 'bans.add',
        target: body.name,
        ipAddress: request.ip,
        success: result.success,
        details: { reason: body.reason },
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
    '/api/bans/remove',
    { preHandler: [requireAuth, requireRole('admin')] },
    async (request, reply) => {
      const body = RemoveBanSchema.parse(request.body);
      let result;
      try {
        const status = await serverService.getServerStatus({ strict: true });
        result = await banService.removeBan(body.name, status.running);
      } catch (err) {
        return sendHelperDegraded(reply, err);
      }

      await logAudit({
        userId: request.currentUser!.id,
        action: 'bans.remove',
        target: body.name,
        ipAddress: request.ip,
        success: result.success,
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
