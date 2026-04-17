import type { FastifyReply } from 'fastify';
import { getConfig } from '../config';

export function setSessionCookie(reply: FastifyReply, sessionId: string, maxAgeSeconds: number): void {
  const config = getConfig();

  reply.setCookie('hytale_session', sessionId, {
    httpOnly: true,
    secure: config.nodeEnv === 'production',
    sameSite: 'strict',
    path: '/',
    maxAge: maxAgeSeconds,
    domain: config.cookieDomain || undefined,
  });
}

export function clearSessionCookie(reply: FastifyReply): void {
  const config = getConfig();

  reply.clearCookie('hytale_session', {
    path: '/',
    domain: config.cookieDomain || undefined,
  });
}
