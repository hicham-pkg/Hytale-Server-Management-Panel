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
const USER_ADMIN_GUARD_LOCK_KEY = 0x48545541; // 'HTUA'

async function countOtherAdmins(db: Pick<ReturnType<typeof getDb>, 'select'>, excludeUserId: string): Promise<number> {
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

      const updates: Record<string, unknown> = { updatedAt: new Date() };
      if (body.role) updates.role = body.role;
      if (body.password) updates.passwordHash = await hashPassword(body.password);

      const changedFields = Object.keys(body).filter((key) => (body as Record<string, unknown>)[key] !== undefined);
      const updateResult = await db.transaction(async (tx) => {
        await tx.execute(sql`SELECT pg_advisory_xact_lock(${USER_ADMIN_GUARD_LOCK_KEY})`);

        // Prevent demoting the last admin to readonly, which would brick user
        // management. The advisory transaction lock serializes this check with
        // other admin role/delete mutations so concurrent requests cannot both
        // pass the guard against the same pre-change state.
        if (body.role === 'readonly') {
          const otherAdmins = await countOtherAdmins(tx, params.id);
          if (otherAdmins === 0) {
            const [target] = await tx
              .select({ id: users.id, role: users.role })
              .from(users)
              .where(eq(users.id, params.id))
              .limit(1);
            if (target && target.role === 'admin') {
              return { status: 'last_admin_blocked' as const };
            }
          }
        }

        const updatedUsers = await tx
          .update(users)
          .set(updates)
          .where(eq(users.id, params.id))
          .returning({ id: users.id });

        if (updatedUsers.length === 0) {
          return { status: 'not_found' as const };
        }

        // If role or password changed, invalidate all sessions for that user
        if (body.role || body.password) {
          await tx.delete(sessions).where(eq(sessions.userId, params.id));
        }

        return { status: 'updated' as const };
      });

      if (updateResult.status === 'last_admin_blocked') {
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

      if (updateResult.status === 'not_found') {
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

      const deleteResult = await db.transaction(async (tx) => {
        await tx.execute(sql`SELECT pg_advisory_xact_lock(${USER_ADMIN_GUARD_LOCK_KEY})`);

        // Prevent deleting the last admin. The advisory transaction lock keeps
        // the target lookup/admin count/delete sequence atomic relative to
        // other admin role/delete mutations.
        const [target] = await tx
          .select({ id: users.id, role: users.role })
          .from(users)
          .where(eq(users.id, params.id))
          .limit(1);
        if (target && target.role === 'admin') {
          const otherAdmins = await countOtherAdmins(tx, params.id);
          if (otherAdmins === 0) {
            return { status: 'last_admin_blocked' as const };
          }
        }

        const deletedUsers = await tx
          .delete(users)
          .where(eq(users.id, params.id))
          .returning({ id: users.id });

        return deletedUsers.length === 0
          ? { status: 'not_found' as const }
          : { status: 'deleted' as const };
      });

      if (deleteResult.status === 'last_admin_blocked') {
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

      if (deleteResult.status === 'not_found') {
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
