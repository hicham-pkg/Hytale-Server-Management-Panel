import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { CreateUserSchema, UpdateUserSchema, UUID_REGEX } from '@hytale-panel/shared';
import { getDb, schema } from '../db';
import { hashPassword } from '../utils/crypto';
import { logAudit } from '../services/audit.service';
import { requireAuth } from '../middleware/require-auth';
import { requireRole } from '../middleware/require-role';

const { users, sessions } = schema;

export async function userRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get(
    '/api/users',
    { preHandler: [requireAuth, requireRole('admin')] },
    async (_request, reply) => {
      const db = getDb();
      const rows = await db.select({
        id: users.id,
        username: users.username,
        role: users.role,
        totpEnabled: users.totpEnabled,
        createdAt: users.createdAt,
        updatedAt: users.updatedAt,
      }).from(users);

      return reply.send({ success: true, data: { users: rows } });
    }
  );

  fastify.post(
    '/api/users',
    { preHandler: [requireAuth, requireRole('admin')] },
    async (request, reply) => {
      const body = CreateUserSchema.parse(request.body);
      const db = getDb();

      const existing = await db.select().from(users).where(eq(users.username, body.username)).limit(1);
      if (existing.length > 0) {
        return reply.status(409).send({ success: false, error: 'Username already exists' });
      }

      const passwordHash = await hashPassword(body.password);
      const [newUser] = await db.insert(users).values({
        username: body.username,
        passwordHash,
        role: body.role,
      }).returning({ id: users.id, username: users.username, role: users.role });

      await logAudit({
        userId: request.currentUser!.id,
        action: 'user.create',
        target: body.username,
        details: { role: body.role },
        ipAddress: request.ip,
        success: true,
      });

      return reply.status(201).send({ success: true, data: { user: newUser } });
    }
  );

  fastify.put(
    '/api/users/:id',
    { preHandler: [requireAuth, requireRole('admin')] },
    async (request, reply) => {
      const params = z.object({ id: z.string().regex(UUID_REGEX) }).parse(request.params);
      const body = UpdateUserSchema.parse(request.body);
      const db = getDb();

      const updates: Record<string, unknown> = { updatedAt: new Date() };
      if (body.role) updates.role = body.role;
      if (body.password) updates.passwordHash = await hashPassword(body.password);

      await db.update(users).set(updates).where(eq(users.id, params.id));

      // If role or password changed, invalidate all sessions for that user
      if (body.role || body.password) {
        await db.delete(sessions).where(eq(sessions.userId, params.id));
      }

      await logAudit({
        userId: request.currentUser!.id,
        action: 'user.update',
        target: params.id,
        details: { changedFields: Object.keys(body).filter(k => (body as any)[k] !== undefined) },
        ipAddress: request.ip,
        success: true,
      });

      return reply.send({ success: true });
    }
  );

  fastify.delete(
    '/api/users/:id',
    { preHandler: [requireAuth, requireRole('admin')] },
    async (request, reply) => {
      const params = z.object({ id: z.string().regex(UUID_REGEX) }).parse(request.params);
      const db = getDb();

      // Prevent self-deletion
      if (params.id === request.currentUser!.id) {
        return reply.status(400).send({ success: false, error: 'Cannot delete your own account' });
      }

      await db.delete(users).where(eq(users.id, params.id));

      await logAudit({
        userId: request.currentUser!.id,
        action: 'user.delete',
        target: params.id,
        ipAddress: request.ip,
        success: true,
      });

      return reply.send({ success: true });
    }
  );
}
