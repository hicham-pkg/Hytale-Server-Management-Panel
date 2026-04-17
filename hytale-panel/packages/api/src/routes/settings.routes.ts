import type { FastifyInstance } from 'fastify';
import { UpdateSettingsSchema } from '@hytale-panel/shared';
import * as settingsService from '../services/settings.service';
import { logAudit } from '../services/audit.service';
import { requireAuth } from '../middleware/require-auth';
import { requireRole } from '../middleware/require-role';

/**
 * Dangerous keys that must never be settable via the API.
 * These are configured via the helper's .env file only.
 */
const BLOCKED_SETTING_KEYS = new Set([
  'hytaleRoot',
  'whitelistPath',
  'bansPath',
  'backupPath',
  'serviceName',
  'enableDangerousActions',
]);

export async function settingsRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get(
    '/api/settings',
    { preHandler: [requireAuth, requireRole('admin')] },
    async (_request, reply) => {
      const allSettings = await settingsService.getAllSettings();

      // Filter out any dangerous keys from the response
      const safeSettings: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(allSettings)) {
        if (!BLOCKED_SETTING_KEYS.has(key)) {
          safeSettings[key] = value;
        }
      }

      return reply.send({ success: true, data: safeSettings });
    }
  );

  fastify.put(
    '/api/settings',
    { preHandler: [requireAuth, requireRole('admin')] },
    async (request, reply) => {
      // Zod schema already restricts to safe keys only
      const body = UpdateSettingsSchema.parse(request.body);

      // Defense-in-depth: reject any blocked keys that somehow pass validation
      const keys = Object.keys(body);
      for (const key of keys) {
        if (BLOCKED_SETTING_KEYS.has(key)) {
          return reply.status(400).send({
            success: false,
            error: `Setting "${key}" cannot be changed via the API. Configure it in the helper .env file.`,
          });
        }
      }

      await settingsService.updateSettings(body as Record<string, unknown>, request.currentUser!.id);

      await logAudit({
        userId: request.currentUser!.id,
        action: 'settings.update',
        details: { keys },
        ipAddress: request.ip,
        success: true,
      });

      return reply.send({ success: true });
    }
  );
}