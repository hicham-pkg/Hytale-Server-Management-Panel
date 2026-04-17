import type { FastifyRequest, FastifyReply } from 'fastify';
import { validateSession } from '../services/auth.service';
import { clearSessionCookie, setSessionCookie } from '../utils/session-cookie';

declare module 'fastify' {
  interface FastifyRequest {
    sessionId?: string;
    currentUser?: {
      id: string;
      username: string;
      role: string;
      totpEnabled: boolean;
    };
  }
}

/**
 * Authentication guard. Validates session cookie and attaches user to request.
 */
async function attachSession(
  request: FastifyRequest,
  reply: FastifyReply,
  options: { allowAdminTotpSetup?: boolean } = {}
): Promise<boolean> {
  const sessionId = request.cookies?.['hytale_session'];

  if (!sessionId) {
    reply.status(401).send({ success: false, error: 'Authentication required' });
    return false;
  }

  const result = await validateSession(sessionId, options);

  if (!result.valid) {
    if (result.requiresTotpSetup) {
      reply.status(403).send({ success: false, error: 'Admin TOTP setup required' });
      return false;
    }
    if (result.pending2fa) {
      reply.status(401).send({ success: false, error: '2FA verification required' });
      return false;
    }
    clearSessionCookie(reply);
    reply.status(401).send({ success: false, error: 'Invalid or expired session' });
    return false;
  }

  request.sessionId = sessionId;
  request.currentUser = result.user!;
  if (result.cookieMaxAgeSeconds) {
    setSessionCookie(reply, sessionId, result.cookieMaxAgeSeconds);
  }
  return true;
}

export async function requireAuth(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  await attachSession(request, reply);
}

export async function requireTotpEnrollmentSession(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  const attached = await attachSession(request, reply, { allowAdminTotpSetup: true });
  if (!attached) {
    return;
  }

  if (request.currentUser!.role !== 'admin') {
    reply.status(403).send({ success: false, error: 'Admin only' });
  }
}
