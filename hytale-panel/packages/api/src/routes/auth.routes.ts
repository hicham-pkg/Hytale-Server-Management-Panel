import type { FastifyInstance } from 'fastify';
import { LoginSchema, VerifyTotpSchema, SetupTotpSchema, ConfirmTotpSchema } from '@hytale-panel/shared';
import * as authService from '../services/auth.service';
import { logAudit } from '../services/audit.service';
import { requireAuth, requireTotpEnrollmentSession } from '../middleware/require-auth';
import { getConfig } from '../config';
import { clearSessionCookie, setSessionCookie } from '../utils/session-cookie';
import { generateCsrfToken } from '../utils/csrf';

export async function authRoutes(fastify: FastifyInstance): Promise<void> {
  const config = getConfig();

  fastify.post('/api/auth/login', {
    config: {
      rateLimit: {
        max: config.loginRateLimitMax,
        timeWindow: config.loginRateLimitWindowMs,
      },
    },
  }, async (request, reply) => {
    const body = LoginSchema.parse(request.body);
    const ip = request.ip;
    const ua = request.headers['user-agent'] ?? '';

    const result = await authService.login(body.username, body.password, ip, ua);

    await logAudit({
      userId: result.user?.id ?? null,
      action: 'auth.login',
      target: body.username,
      details: {
        requires2fa: result.requires2fa,
        requiresTotpSetup: result.requiresTotpSetup ?? false,
      },
      ipAddress: ip,
      success: result.success,
    });

    if (!result.success) {
      return reply.status(401).send({ success: false, error: result.error });
    }

    setSessionCookie(reply, result.sessionId!, result.cookieMaxAgeSeconds!);

    if (result.requires2fa) {
      // Return CSRF token even for pending-2FA sessions so the frontend
      // can include it on the subsequent verify-totp request.
      return reply.send({
        success: true,
        data: {
          requires2fa: true,
          csrfToken: generateCsrfToken(config.csrfSecret, result.sessionId!),
        },
      });
    }

    if (result.requiresTotpSetup) {
      return reply.send({
        success: true,
        data: {
          requires2fa: false,
          requiresTotpSetup: true,
          csrfToken: generateCsrfToken(config.csrfSecret, result.sessionId!),
        },
      });
    }

    // Also return CSRF token
    return reply.send({
      success: true,
      data: {
        requires2fa: false,
        user: result.user,
        csrfToken: generateCsrfToken(config.csrfSecret, result.sessionId!),
      },
    });
  });

  fastify.post('/api/auth/verify-totp', {
    config: {
      rateLimit: {
        max: config.loginRateLimitMax,
        timeWindow: config.loginRateLimitWindowMs,
      },
    },
  }, async (request, reply) => {
    const sessionId = request.cookies?.['hytale_session'];
    if (!sessionId) {
      return reply.status(401).send({ success: false, error: 'No session' });
    }

    const body = VerifyTotpSchema.parse(request.body);
    const result = await authService.verifyTotp(sessionId, body.code);

    await logAudit({
      userId: result.user?.id ?? null,
      action: 'auth.verify_totp',
      ipAddress: request.ip,
      success: result.success,
    });

    if (!result.success) {
      return reply.status(401).send({ success: false, error: result.error });
    }

    // verifyTotp rotates the session UUID, so the new sessionId must drive
    // both the cookie reset and the CSRF token bound to that session.
    const newSessionId = result.sessionId!;
    setSessionCookie(reply, newSessionId, result.cookieMaxAgeSeconds!);

    return reply.send({
      success: true,
      data: {
        user: result.user,
        csrfToken: generateCsrfToken(config.csrfSecret, newSessionId),
      },
    });
  });

  fastify.post('/api/auth/logout', { preHandler: [requireAuth] }, async (request, reply) => {
    await authService.destroySession(request.sessionId!);

    await logAudit({
      userId: request.currentUser!.id,
      action: 'auth.logout',
      ipAddress: request.ip,
      success: true,
    });

    clearSessionCookie(reply);
    return reply.send({ success: true });
  });

  fastify.get('/api/auth/me', { preHandler: [requireAuth] }, async (request, reply) => {
    return reply.send({
      success: true,
      data: {
        user: request.currentUser,
        csrfToken: (request as any).csrfToken,
      },
    });
  });

  fastify.post('/api/auth/setup-totp', { preHandler: [requireTotpEnrollmentSession] }, async (request, reply) => {
    SetupTotpSchema.parse(request.body ?? {});
    const result = await authService.setupTotp(request.currentUser!.id);
    return reply.send({ success: true, data: result });
  });

  fastify.post('/api/auth/confirm-totp', { preHandler: [requireTotpEnrollmentSession] }, async (request, reply) => {
    const body = ConfirmTotpSchema.parse(request.body);
    const result = await authService.confirmTotp(request.currentUser!.id, body.code, request.sessionId);

    await logAudit({
      userId: request.currentUser!.id,
      action: 'auth.confirm_totp',
      ipAddress: request.ip,
      success: result.success,
    });

    if (!result.success) {
      return reply.status(400).send({ success: false, error: 'Invalid TOTP code' });
    }

    if (result.sessionId && result.cookieMaxAgeSeconds) {
      setSessionCookie(reply, result.sessionId, result.cookieMaxAgeSeconds);
      return reply.send({
        success: true,
        data: {
          user: result.user,
          csrfToken: generateCsrfToken(config.csrfSecret, result.sessionId),
        },
      });
    }

    return reply.send({ success: true });
  });
}
