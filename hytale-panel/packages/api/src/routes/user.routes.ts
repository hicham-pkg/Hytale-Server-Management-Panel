import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { and, eq, ne, sql } from 'drizzle-orm';
import { CreateUserSchema, UpdateUserSchema, UUID_REGEX } from '@hytale-panel/shared';
import { getDb, schema } from '../db';
import { hashPassword } from '../utils/crypto';
import { logAudit } from '../services/audit.service';
import { requireAuth } from '../middleware/require-auth';
import { requireRole } from '../middleware/require-role';

const { users, sessions } = schema;

async function countOtherAdmins(db: ReturnType<typeof getDb>, excludeUserId: string): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)` })
    .from(users)
    .where(and(eq(users.role, 'admin'), ne(users.id, excludeUserId)));
  return Number(row?.count ?? 0);
}

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

      // Prevent demoting the last admin to readonly, which would brick user
      // management. Checking `ne(id, target)` means we count admins OTHER
      // THAN the one being changed — if that count is 0 and we're demoting,
      // the target is the only admin left.
      if (body.role === 'readonly') {
        const otherAdmins = await countOtherAdmins(db, params.id);
        if (otherAdmins === 0) {
          const [target] = await db
            .select({ id: users.id, role: users.role })
            .from(users)
            .where(eq(users.id, params.id))
            .limit(1);
          if (target && target.role === 'admin') {
            await logAudit({
              userId: request.currentUser!.id,
              action: 'user.update',
              target: params.id,
              details: { reason: 'last_admin_demotion_blocked' },
              ipAddress: request.ip,
              success: false,
            });
            return reply.status(400).send({
              success: false,
              error: 'Cannot demote the last admin. Promote another user to admin first.',
            });
          }
        }
      }

      const updates: Record<string, unknown> = { updatedAt: new Date() };
      if (body.role) updates.role = body.role;
      if (body.password) updates.passwordHash = await hashPassword(body.password);

      const changedFields = Object.keys(body).filter((key) => (body as Record<string, unknown>)[key] !== undefined);
      const updatedUsers = await db
        .update(users)
        .set(updates)
        .where(eq(users.id, params.id))
        .returning({ id: users.id });

      if (updatedUsers.length === 0) {
        await logAudit({
          userId: request.currentUser!.id,
          action: 'user.update',
          target: params.id,
          details: { changedFields, reason: 'user_not_found' },
          ipAddress: request.ip,
          success: false,
        });
        return reply.status(404).send({ success: false, error: 'User not found' });
      }

      // If role or password changed, invalidate all sessions for that user
      if (body.role || body.password) {
        await db.delete(sessions).where(eq(sessions.userId, params.id));
      }

      await logAudit({
        userId: request.currentUser!.id,
        action: 'user.update',
        target: params.id,
        details: { changedFields },
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

      // Prevent deleting the last admin (the target may be the lone remaining
      // admin, or the lone remaining admin could be the invoker themselves —
      // both states leave no one to promote another user).
      const [target] = await db
        .select({ id: users.id, role: users.role })
        .from(users)
        .where(eq(users.id, params.id))
        .limit(1);
      if (target && target.role === 'admin') {
        const otherAdmins = await countOtherAdmins(db, params.id);
        if (otherAdmins === 0) {
          await logAudit({
            userId: request.currentUser!.id,
            action: 'user.delete',
            target: params.id,
            details: { reason: 'last_admin_deletion_blocked' },
            ipAddress: request.ip,
            success: false,
          });
          return reply.status(400).send({
            success: false,
            error: 'Cannot delete the last admin. Promote another user to admin first.',
          });
        }
      }

      const deletedUsers = await db
        .delete(users)
        .where(eq(users.id, params.id))
        .returning({ id: users.id });

      if (deletedUsers.length === 0) {
        await logAudit({
          userId: request.currentUser!.id,
          action: 'user.delete',
          target: params.id,
          details: { reason: 'user_not_found' },
          ipAddress: request.ip,
          success: false,
        });
        return reply.status(404).send({ success: false, error: 'User not found' });
      }

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
