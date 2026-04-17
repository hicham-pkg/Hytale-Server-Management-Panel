import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import fp from 'fastify-plugin';
import * as crypto from 'crypto';
import { getConfig } from '../config';
import { CSRF_TOKEN_HEX_LENGTH, generateCsrfToken } from '../utils/csrf';

const SAFE_METHODS = ['GET', 'HEAD', 'OPTIONS'];

async function csrfPlugin(fastify: FastifyInstance): Promise<void> {
  fastify.decorateRequest('csrfToken', '');

  fastify.addHook('onRequest', async (request: FastifyRequest, reply: FastifyReply) => {
    const config = getConfig();
    const sessionId = request.cookies?.['hytale_session'] ?? 'anonymous';

    // Generate token for this request
    (request as any).csrfToken = generateCsrfToken(config.csrfSecret, sessionId);

    // Skip validation for safe methods
    if (SAFE_METHODS.includes(request.method)) return;

    // Skip for WebSocket upgrades
    if (request.headers.upgrade === 'websocket') return;

    // Skip for auth login (no session yet)
    if (request.url === '/api/auth/login') return;

    const token = request.headers['x-csrf-token'] as string;

    // Validate token exists and has correct length before timingSafeEqual
    if (!token || token.length !== CSRF_TOKEN_HEX_LENGTH) {
      reply.status(403).send({ success: false, error: 'Invalid CSRF token' });
      return;
    }

    const expected = generateCsrfToken(config.csrfSecret, sessionId);
    const tokenBuf = Buffer.from(token, 'utf-8');
    const expectedBuf = Buffer.from(expected, 'utf-8');

    // Both buffers should be the same length since we validated token.length above,
    // but guard defensively in case of encoding differences
    if (tokenBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(tokenBuf, expectedBuf)) {
      reply.status(403).send({ success: false, error: 'Invalid CSRF token' });
      return;
    }
  });
}

export default fp(csrfPlugin, { name: 'csrf' });
