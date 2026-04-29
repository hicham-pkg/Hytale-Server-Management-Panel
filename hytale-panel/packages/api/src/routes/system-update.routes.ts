import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import * as updateChecker from '../services/update-checker.service';
import * as panelUpdate from '../services/panel-update.service';
import { getConfig } from '../config';
import { logAudit } from '../services/audit.service';
import { requireAuth } from '../middleware/require-auth';
import { requireRole } from '../middleware/require-role';

/**
 * Panel update checker — admin-only, read-only.
 *
 * GET /api/system/updates/status?force=<bool>
 *   force=true bypasses the cache and forces a fresh GitHub API call.
 *
 * The response intentionally never includes the GITHUB_UPDATE_TOKEN — the
 * service layer is responsible for keeping it server-side. Routes here just
 * wrap the audited admin-gated call.
 */
export async function systemUpdateRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get(
    '/api/system/updates/status',
    { preHandler: [requireAuth, requireRole('admin')] },
    async (request, reply) => {
      const query = z
        .object({
          force: z
            .union([z.literal('true'), z.literal('false'), z.literal('1'), z.literal('0')])
            .optional(),
        })
        .parse(request.query ?? {});
      const force = query.force === 'true' || query.force === '1';

      const status = await updateChecker.getUpdateStatus({ force });

      // Audit log entry — note: token must NEVER be in details.
      await logAudit({
        userId: request.currentUser!.id,
        action: 'system.update_check',
        ipAddress: request.ip,
        success: !status.error,
        details: {
          force,
          fromCache: status.fromCache,
          currentVersion: status.currentVersion,
          latestVersion: status.latestVersion,
          checkStatus: status.checkStatus,
          updateAvailable: status.updateAvailable,
          ...(status.error ? { error: status.error } : {}),
        },
      });

      return reply.send({ success: true, data: status });
    },
  );

  // ─── Panel Updater (V2) — admin-only ─────────────────────────────────
  // start, rollback, get/list job status, get logs

  fastify.post(
    '/api/system/updates/start',
    { preHandler: [requireAuth, requireRole('admin')] },
    async (request, reply) => {
      const config = getConfig();
      if (!config.panelUpdateInstallEnabled) {
        await logAudit({
          userId: request.currentUser!.id,
          action: 'panel.update_start',
          ipAddress: request.ip,
          success: false,
          details: { reason: 'PANEL_UPDATE_INSTALL_ENABLED=false' },
        });
        return reply.status(403).send({
          success: false,
          error: 'Panel updates are disabled by configuration',
        });
      }

      // We don't accept arbitrary URLs. The button uses the cached
      // updateChecker result; we re-check here for freshness AND to derive
      // the canonical download URL inside the trust boundary.
      const fresh = await updateChecker.getUpdateStatus({ force: true });
      if (fresh.checkStatus !== 'ok') {
        await logAudit({
          userId: request.currentUser!.id,
          action: 'panel.update_start',
          ipAddress: request.ip,
          success: false,
          details: {
            reason: 'update-check-unavailable',
            currentVersion: fresh.currentVersion,
            latestVersion: fresh.latestVersion,
            ...(fresh.error ? { error: fresh.error } : {}),
          },
        });
        return reply.status(503).send({
          success: false,
          error: fresh.error
            ? `Could not check GitHub Releases: ${fresh.error}`
            : 'Could not check GitHub Releases',
        });
      }
      if (!fresh.updateAvailable || !fresh.latestVersion || !fresh.latestTag) {
        await logAudit({
          userId: request.currentUser!.id,
          action: 'panel.update_start',
          ipAddress: request.ip,
          success: false,
          details: { reason: 'no-update-available', currentVersion: fresh.currentVersion, latestVersion: fresh.latestVersion },
        });
        return reply.status(409).send({
          success: false,
          error: 'No newer release available',
        });
      }

      // Always download the GitHub source tarball for the resolved release tag.
      // Use codeload directly instead of the GitHub API archive endpoint: the
      // runner expects a tar.gz body, not API JSON/content negotiation.
      const repo = config.panelUpdateRepo;
      const tag = encodeURIComponent(fresh.latestTag);
      const downloadUrl = `https://codeload.github.com/${repo}/tar.gz/refs/tags/${tag}`;

      const result = await panelUpdate.startPanelUpdate({
        targetTag: fresh.latestTag,
        downloadUrl,
        tarballType: 'tar.gz',
        expectedSha256: null,
        currentVersion: fresh.currentVersion,
      });

      await logAudit({
        userId: request.currentUser!.id,
        action: 'panel.update_start',
        ipAddress: request.ip,
        success: result.success,
        details: result.success
          ? { jobId: result.jobId, currentVersion: fresh.currentVersion, targetTag: fresh.latestTag }
          : { error: result.error, currentVersion: fresh.currentVersion, targetTag: fresh.latestTag },
      });

      if (!result.success) {
        return reply.status(409).send({ success: false, error: result.error });
      }
      return reply.send({ success: true, data: { jobId: result.jobId } });
    },
  );

  fastify.post(
    '/api/system/updates/rollback',
    { preHandler: [requireAuth, requireRole('admin')] },
    async (request, reply) => {
      const config = getConfig();
      if (!config.panelUpdateInstallEnabled) {
        return reply.status(403).send({ success: false, error: 'Panel updates are disabled' });
      }
      const body = z
        .object({ backupPath: z.string().min(1).max(500).optional() })
        .parse(request.body ?? {});

      const result = await panelUpdate.rollbackPanelUpdate({ backupPath: body.backupPath });

      await logAudit({
        userId: request.currentUser!.id,
        action: 'panel.update_rollback',
        ipAddress: request.ip,
        success: result.success,
        details: result.success
          ? { jobId: result.jobId, backupPath: body.backupPath ?? null }
          : { error: result.error, backupPath: body.backupPath ?? null },
      });

      if (!result.success) {
        return reply.status(409).send({ success: false, error: result.error });
      }
      return reply.send({ success: true, data: { jobId: result.jobId } });
    },
  );

  fastify.get(
    '/api/system/updates/jobs/latest',
    { preHandler: [requireAuth, requireRole('admin')] },
    async (_request, reply) => {
      const job = panelUpdate.latestJob();
      return reply.send({ success: true, data: job });
    },
  );

  fastify.get(
    '/api/system/updates/jobs/:jobId',
    { preHandler: [requireAuth, requireRole('admin')] },
    async (request, reply) => {
      const params = z.object({ jobId: z.string().uuid() }).parse(request.params);
      const status = panelUpdate.readJobStatus(params.jobId);
      if (!status) {
        return reply.status(404).send({ success: false, error: 'Job not found' });
      }
      return reply.send({ success: true, data: status });
    },
  );

  fastify.get(
    '/api/system/updates/jobs/:jobId/logs',
    { preHandler: [requireAuth, requireRole('admin')] },
    async (request, reply) => {
      const params = z.object({ jobId: z.string().uuid() }).parse(request.params);
      const query = z
        .object({ cursor: z.coerce.number().int().min(0).max(10_485_760).optional() })
        .parse(request.query ?? {});
      const tail = panelUpdate.readJobLogs(params.jobId, query.cursor ?? 0);
      if (!tail) {
        return reply.status(404).send({ success: false, error: 'Job not found' });
      }
      return reply.send({ success: true, data: tail });
    },
  );
}
