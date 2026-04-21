import type { FastifyInstance } from 'fastify';
import {
  AddPlayerSchema,
  RemovePlayerSchema,
  RemovePlayerByUuidSchema,
  ToggleWhitelistSchema,
} from '@hytale-panel/shared';
import * as whitelistService from '../services/whitelist.service';
import * as serverService from '../services/server.service';
import { logAudit } from '../services/audit.service';
import { requireAuth } from '../middleware/require-auth';
import { requireRole } from '../middleware/require-role';
import { isHelperUnavailableError } from '../services/helper-client';

export async function whitelistRoutes(fastify: FastifyInstance): Promise<void> {
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
    '/api/whitelist',
    { preHandler: [requireAuth] },
    async (_request, reply) => {
      try {
        const result = await whitelistService.getWhitelist();
        if (!result.success) {
          return reply.status(409).send({
            success: false,
            error: result.error ?? 'Failed to read whitelist',
          });
        }

        const status = await serverService.getServerStatus({ strict: true });
        return reply.send({
          success: result.success,
          data: {
            enabled: result.enabled,
            list: result.list,
            serverRunning: status.running,
          },
          error: result.success ? undefined : result.error,
        });
      } catch (err) {
        return sendHelperDegraded(reply, err);
      }
    }
  );

  /**
   * Online add: by player name. Requires server running.
   * The Hytale server resolves the name to a UUID internally.
   */
  fastify.post(
    '/api/whitelist/add',
    { preHandler: [requireAuth, requireRole('admin')] },
    async (request, reply) => {
      const body = AddPlayerSchema.parse(request.body);
      let result;
      try {
        const status = await serverService.getServerStatus({ strict: true });
        result = await whitelistService.addPlayer(body.name, status.running);
      } catch (err) {
        return sendHelperDegraded(reply, err);
      }

      await logAudit({
        userId: request.currentUser!.id,
        action: 'whitelist.add',
        target: body.name,
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

  /**
   * Online remove: by player name via console command. Requires server running.
   */
  fastify.post(
    '/api/whitelist/remove',
    { preHandler: [requireAuth, requireRole('admin')] },
    async (request, reply) => {
      const body = RemovePlayerSchema.parse(request.body);
      let result;
      try {
        const status = await serverService.getServerStatus({ strict: true });
        result = await whitelistService.removePlayerOnline(body.name, status.running);
      } catch (err) {
        return sendHelperDegraded(reply, err);
      }

      await logAudit({
        userId: request.currentUser!.id,
        action: 'whitelist.remove_online',
        target: body.name,
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

  /**
   * Offline remove: by UUID from file. Requires server stopped.
   * Directly edits the whitelist.json file to remove a UUID entry.
   */
  fastify.post(
    '/api/whitelist/remove-offline',
    { preHandler: [requireAuth, requireRole('admin')] },
    async (request, reply) => {
      const body = RemovePlayerByUuidSchema.parse(request.body);
      let result;
      try {
        const status = await serverService.getServerStatus({ strict: true });
        result = await whitelistService.removePlayerOffline(body.uuid, status.running);
      } catch (err) {
        return sendHelperDegraded(reply, err);
      }

      await logAudit({
        userId: request.currentUser!.id,
        action: 'whitelist.remove_offline',
        target: body.uuid,
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
    '/api/whitelist/toggle',
    { preHandler: [requireAuth, requireRole('admin')] },
    async (request, reply) => {
      const body = ToggleWhitelistSchema.parse(request.body);
      let result;
      try {
        const status = await serverService.getServerStatus({ strict: true });
        result = await whitelistService.toggleWhitelist(body.enabled, status.running);
      } catch (err) {
        return sendHelperDegraded(reply, err);
      }

      await logAudit({
        userId: request.currentUser!.id,
        action: 'whitelist.toggle',
        target: String(body.enabled),
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
