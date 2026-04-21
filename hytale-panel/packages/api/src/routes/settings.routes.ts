import type { FastifyInstance } from 'fastify';
import { requireAuth } from '../middleware/require-auth';
import { requireRole } from '../middleware/require-role';

const SETTINGS_DEPRECATED_ERROR =
  'Settings API is deprecated. Configure panel behavior via .env and helper .env files.';

export async function settingsRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get(
    '/api/settings',
    { preHandler: [requireAuth, requireRole('admin')] },
    async (_request, reply) => {
      return reply.status(410).send({ success: false, error: SETTINGS_DEPRECATED_ERROR });
    }
  );

  fastify.put(
    '/api/settings',
    { preHandler: [requireAuth, requireRole('admin')] },
    async (_request, reply) => {
      return reply.status(410).send({ success: false, error: SETTINGS_DEPRECATED_ERROR });
    }
  );
}
