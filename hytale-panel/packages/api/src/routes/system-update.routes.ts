import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import * as updateChecker from '../services/update-checker.service';
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
          updateAvailable: status.updateAvailable,
          ...(status.error ? { error: status.error } : {}),
        },
      });

      return reply.send({ success: true, data: status });
    },
  );
}
