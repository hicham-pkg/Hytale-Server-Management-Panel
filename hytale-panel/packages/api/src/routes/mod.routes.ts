import type { FastifyInstance } from 'fastify';
import type { Readable } from 'stream';
import { z } from 'zod';
import { MOD_FILENAME_REGEX, UUID_REGEX } from '@hytale-panel/shared';
import { getConfig } from '../config';
import { isHelperUnavailableError } from '../services/helper-client';
import { logAudit } from '../services/audit.service';
import { requireAuth } from '../middleware/require-auth';
import { requireRole } from '../middleware/require-role';
import * as modService from '../services/mod.service';

const InstallBodySchema = z.object({
  stagedId: z.string().regex(UUID_REGEX),
  sanitizedName: z.string().regex(MOD_FILENAME_REGEX),
  sha256: z.string().regex(/^[a-f0-9]{64}$/i),
  replace: z.boolean().optional(),
  restartNow: z.boolean().optional(),
  autoRollback: z.boolean().optional(),
});

const ModNameParamsSchema = z.object({
  name: z.string().regex(MOD_FILENAME_REGEX),
});

function sendHelperDegraded(
  reply: { status: (code: number) => { send: (payload: unknown) => unknown } },
  err: unknown,
  fallback = 'Mod operation failed'
) {
  if (isHelperUnavailableError(err)) {
    return reply.status(503).send({
      success: false,
      error: 'Helper service unavailable',
      data: {
        degraded: true,
        dependency: 'helper',
      },
    });
  }

  return reply.status(409).send({
    success: false,
    error: (err as Error).message || fallback,
  });
}

function auditDetails(details: unknown): Record<string, unknown> {
  return details && typeof details === 'object'
    ? { ...(details as Record<string, unknown>) }
    : { value: details };
}

export async function modRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.addContentTypeParser('application/octet-stream', (_request, payload, done) => {
    done(null, payload);
  });

  fastify.get(
    '/api/mods',
    { preHandler: [requireAuth] },
    async (_request, reply) => {
      try {
        const result = await modService.listMods();
        return reply.send({ success: true, data: result });
      } catch (err) {
        return sendHelperDegraded(reply, err, 'Failed to list mods');
      }
    }
  );

  fastify.post(
    '/api/mods/upload',
    {
      preHandler: [requireAuth, requireRole('admin')],
      bodyLimit: getConfig().maxModUploadSizeMb * 1024 * 1024,
    },
    async (request, reply) => {
      const config = getConfig();
      const rawFilename = request.headers['x-mod-filename'];
      if (typeof rawFilename !== 'string' || !rawFilename.trim()) {
        return reply.status(400).send({ success: false, error: 'Missing x-mod-filename header' });
      }

      const contentLengthRaw = request.headers['content-length'];
      const contentLength = typeof contentLengthRaw === 'string' ? Number(contentLengthRaw) : undefined;
      if (contentLength !== undefined && (!Number.isFinite(contentLength) || contentLength < 0)) {
        return reply.status(400).send({ success: false, error: 'Invalid content length' });
      }

      const body = request.body as Readable | undefined;
      if (!body || typeof body.pipe !== 'function') {
        return reply.status(400).send({ success: false, error: 'Expected application/octet-stream upload body' });
      }

      try {
        const staged = await modService.stageModUpload({
          stream: body,
          rawFilename,
          stagingPath: config.modUploadStagingPath,
          maxBytes: config.maxModUploadSizeMb * 1024 * 1024,
          contentLength,
        });

        await logAudit({
          userId: request.currentUser!.id,
          action: 'mods.upload',
          target: staged.sanitizedName,
          ipAddress: request.ip,
          success: true,
          details: {
            stagedId: staged.stagedId,
            sanitizedName: staged.sanitizedName,
            sizeBytes: staged.sizeBytes,
            sha256: staged.sha256,
          },
        });

        return reply.status(201).send({ success: true, data: { staged } });
      } catch (err) {
        await logAudit({
          userId: request.currentUser!.id,
          action: 'mods.upload',
          target: 'rejected-upload',
          ipAddress: request.ip,
          success: false,
          details: { reason: (err as Error).message },
        });
        return reply.status(400).send({ success: false, error: (err as Error).message || 'Mod upload failed' });
      }
    }
  );

  fastify.post(
    '/api/mods/install',
    { preHandler: [requireAuth, requireRole('admin')] },
    async (request, reply) => {
      const body = InstallBodySchema.parse(request.body);
      try {
        const install = await modService.installStagedMod({
          stagedId: body.stagedId,
          sanitizedName: body.sanitizedName,
          sha256: body.sha256,
          replace: body.replace === true,
        });
        const restart = body.restartNow
          ? await modService.restartAndVerifyMods(body.autoRollback === true)
          : undefined;

        await logAudit({
          userId: request.currentUser!.id,
          action: 'mods.install',
          target: body.sanitizedName,
          ipAddress: request.ip,
          success: restart ? restart.startupOk : true,
          details: {
            stagedId: body.stagedId,
            replace: body.replace === true,
            backupName: install.backupName,
            restart,
          },
        });

        return reply
          .status(restart && !restart.startupOk ? 409 : 200)
          .send({
            success: restart ? restart.startupOk : true,
            data: { install, restart },
            error: restart && !restart.startupOk ? restart.message : undefined,
          });
      } catch (err) {
        await logAudit({
          userId: request.currentUser!.id,
          action: 'mods.install',
          target: body.sanitizedName,
          ipAddress: request.ip,
          success: false,
          details: { stagedId: body.stagedId, reason: (err as Error).message },
        });
        return sendHelperDegraded(reply, err, 'Failed to install mod');
      }
    }
  );

  fastify.post(
    '/api/mods/:name/disable',
    { preHandler: [requireAuth, requireRole('admin')] },
    async (request, reply) => {
      const { name } = ModNameParamsSchema.parse(request.params);
      try {
        const result = await modService.disableMod(name);
        await logAudit({ userId: request.currentUser!.id, action: 'mods.disable', target: name, ipAddress: request.ip, success: true, details: auditDetails(result) });
        return reply.send({ success: true, data: result });
      } catch (err) {
        await logAudit({ userId: request.currentUser!.id, action: 'mods.disable', target: name, ipAddress: request.ip, success: false, details: { reason: (err as Error).message } });
        return sendHelperDegraded(reply, err, 'Failed to disable mod');
      }
    }
  );

  fastify.post(
    '/api/mods/:name/enable',
    { preHandler: [requireAuth, requireRole('admin')] },
    async (request, reply) => {
      const { name } = ModNameParamsSchema.parse(request.params);
      try {
        const result = await modService.enableMod(name);
        await logAudit({ userId: request.currentUser!.id, action: 'mods.enable', target: name, ipAddress: request.ip, success: true, details: auditDetails(result) });
        return reply.send({ success: true, data: result });
      } catch (err) {
        await logAudit({ userId: request.currentUser!.id, action: 'mods.enable', target: name, ipAddress: request.ip, success: false, details: { reason: (err as Error).message } });
        return sendHelperDegraded(reply, err, 'Failed to enable mod');
      }
    }
  );

  fastify.delete(
    '/api/mods/:name',
    { preHandler: [requireAuth, requireRole('admin')] },
    async (request, reply) => {
      const { name } = ModNameParamsSchema.parse(request.params);
      const query = z.object({ confirm: z.string() }).parse(request.query);
      if (query.confirm !== name) {
        return reply.status(400).send({ success: false, error: 'Delete confirmation did not match mod name' });
      }

      try {
        const result = await modService.removeMod(name);
        await logAudit({ userId: request.currentUser!.id, action: 'mods.delete', target: name, ipAddress: request.ip, success: true, details: auditDetails(result) });
        return reply.send({ success: true, data: result });
      } catch (err) {
        await logAudit({ userId: request.currentUser!.id, action: 'mods.delete', target: name, ipAddress: request.ip, success: false, details: { reason: (err as Error).message } });
        return sendHelperDegraded(reply, err, 'Failed to delete mod');
      }
    }
  );

  fastify.post(
    '/api/mods/backup',
    { preHandler: [requireAuth, requireRole('admin')] },
    async (request, reply) => {
      try {
        const result = await modService.backupMods();
        await logAudit({ userId: request.currentUser!.id, action: 'mods.backup', ipAddress: request.ip, success: true, details: auditDetails(result) });
        return reply.send({ success: true, data: result });
      } catch (err) {
        await logAudit({ userId: request.currentUser!.id, action: 'mods.backup', ipAddress: request.ip, success: false, details: { reason: (err as Error).message } });
        return sendHelperDegraded(reply, err, 'Failed to back up mods');
      }
    }
  );

  fastify.post(
    '/api/mods/rollback',
    { preHandler: [requireAuth, requireRole('admin')] },
    async (request, reply) => {
      const body = z.object({ backupName: z.string().max(200).optional() }).parse(request.body ?? {});
      try {
        const result = await modService.rollbackMods(body.backupName);
        await logAudit({ userId: request.currentUser!.id, action: 'mods.rollback', target: body.backupName, ipAddress: request.ip, success: true, details: auditDetails(result) });
        return reply.send({ success: true, data: result });
      } catch (err) {
        await logAudit({ userId: request.currentUser!.id, action: 'mods.rollback', target: body.backupName, ipAddress: request.ip, success: false, details: { reason: (err as Error).message } });
        return sendHelperDegraded(reply, err, 'Failed to roll back mods');
      }
    }
  );

  fastify.post(
    '/api/mods/restart-apply',
    { preHandler: [requireAuth, requireRole('admin')] },
    async (request, reply) => {
      const body = z.object({ autoRollback: z.boolean().optional() }).parse(request.body ?? {});
      try {
        const result = await modService.restartAndVerifyMods(body.autoRollback === true);
        await logAudit({ userId: request.currentUser!.id, action: 'mods.restart_apply', ipAddress: request.ip, success: result.startupOk, details: auditDetails(result) });
        return reply.status(result.startupOk ? 200 : 409).send({
          success: result.startupOk,
          data: result,
          error: result.startupOk ? undefined : result.message,
        });
      } catch (err) {
        await logAudit({ userId: request.currentUser!.id, action: 'mods.restart_apply', ipAddress: request.ip, success: false, details: { reason: (err as Error).message } });
        return sendHelperDegraded(reply, err, 'Failed to restart and verify server');
      }
    }
  );
}
