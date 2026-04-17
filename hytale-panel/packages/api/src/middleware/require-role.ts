import type { FastifyRequest, FastifyReply } from 'fastify';

/**
 * Role-based access guard factory.
 * Returns a preHandler that checks if the current user has one of the allowed roles.
 */
export function requireRole(...allowedRoles: string[]) {
  return async function (request: FastifyRequest, reply: FastifyReply): Promise<void> {
    if (!request.currentUser) {
      reply.status(401).send({ success: false, error: 'Authentication required' });
      return;
    }

    if (!allowedRoles.includes(request.currentUser.role)) {
      reply.status(403).send({ success: false, error: 'Insufficient permissions' });
      return;
    }
  };
}