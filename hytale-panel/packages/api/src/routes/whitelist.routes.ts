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

export async function whitelistRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get(
    '/api/whitelist',
    { preHandler: [requireAuth] },
    async (_request, reply) => {
      const result = await whitelistService.getWhitelist();
      const status = await serverService.getServerStatus();
      return reply.send({
        success: result.success,
        data: {
          enabled: result.enabled,
          list: result.list,
          serverRunning: status.running,
        },
      });
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
      const status = await serverService.getServerStatus();
      const result = await whitelistService.addPlayer(body.name, status.running);

      await logAudit({
        userId: request.currentUser!.id,
        action: 'whitelist.add',
        target: body.name,
        ipAddress: request.ip,
        success: result.success,
        details: { message: result.message },
      });

      return reply.send({ success: result.success, data: { message: result.message } });
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
      const status = await serverService.getServerStatus();
      const result = await whitelistService.removePlayerOnline(body.name, status.running);

      await logAudit({
        userId: request.currentUser!.id,
        action: 'whitelist.remove_online',
        target: body.name,
        ipAddress: request.ip,
        success: result.success,
        details: { message: result.message },
      });

      return reply.send({ success: result.success, data: { message: result.message } });
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
      const status = await serverService.getServerStatus();
      const result = await whitelistService.removePlayerOffline(body.uuid, status.running);

      await logAudit({
        userId: request.currentUser!.id,
        action: 'whitelist.remove_offline',
        target: body.uuid,
        ipAddress: request.ip,
        success: result.success,
        details: { message: result.message },
      });

      return reply.send({ success: result.success, data: { message: result.message } });
    }
  );

  fastify.post(
    '/api/whitelist/toggle',
    { preHandler: [requireAuth, requireRole('admin')] },
    async (request, reply) => {
      const body = ToggleWhitelistSchema.parse(request.body);
      const status = await serverService.getServerStatus();
      const result = await whitelistService.toggleWhitelist(body.enabled, status.running);

      await logAudit({
        userId: request.currentUser!.id,
        action: 'whitelist.toggle',
        target: String(body.enabled),
        ipAddress: request.ip,
        success: result.success,
      });

      return reply.send({ success: result.success, data: { message: result.message } });
    }
  );
}