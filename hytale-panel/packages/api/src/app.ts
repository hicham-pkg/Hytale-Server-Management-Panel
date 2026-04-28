import Fastify from 'fastify';
import fastifyCookie from '@fastify/cookie';
import fastifyCors from '@fastify/cors';
import fastifyRateLimit from '@fastify/rate-limit';
import fastifyWebsocket from '@fastify/websocket';
import { ZodError } from 'zod';
import { getConfig } from './config';
import securityHeadersPlugin from './plugins/security-headers';
import csrfPlugin from './plugins/csrf';
import { authRoutes } from './routes/auth.routes';
import { serverRoutes } from './routes/server.routes';
import { consoleRoutes } from './routes/console.routes';
import { whitelistRoutes } from './routes/whitelist.routes';
import { banRoutes } from './routes/ban.routes';
import { backupRoutes } from './routes/backup.routes';
import { backupJobRoutes } from './routes/backup-jobs.routes';
import { modRoutes } from './routes/mod.routes';
import { crashRoutes } from './routes/crash.routes';
import { statsRoutes } from './routes/stats.routes';
import { auditRoutes } from './routes/audit.routes';
import { settingsRoutes } from './routes/settings.routes';
import { userRoutes } from './routes/user.routes';
import { consoleWsHandler } from './ws/console.ws';

export async function buildApp() {
  const config = getConfig();

  const fastify = Fastify({
    logger: {
      level: config.nodeEnv === 'production' ? 'info' : 'debug',
    },
    trustProxy: config.trustProxy,
  });

  // Global error handler for Zod validation errors
  fastify.setErrorHandler((error, _request, reply) => {
    if (error instanceof ZodError) {
      return reply.status(400).send({
        success: false,
        error: 'Validation error',
        details: error.errors.map((e) => ({
          path: e.path.join('.'),
          message: e.message,
        })),
      });
    }

    if (
      error.code === 'FST_ERR_CTP_EMPTY_JSON_BODY' ||
      error.code === 'FST_ERR_CTP_INVALID_JSON_BODY'
    ) {
      return reply.status(400).send({
        success: false,
        error: 'Malformed JSON request body',
      });
    }

    fastify.log.error(error);
    return reply.status(error.statusCode ?? 500).send({
      success: false,
      error: config.nodeEnv === 'production' ? 'Internal server error' : error.message,
    });
  });

  // Plugins
  await fastify.register(fastifyCookie);

  await fastify.register(fastifyCors, {
    origin: config.corsOrigin || false,
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'X-CSRF-Token', 'X-Mod-Filename'],
  });

  await fastify.register(fastifyRateLimit, {
    max: config.globalRateLimitMax,
    timeWindow: config.globalRateLimitWindowMs,
  });

  await fastify.register(securityHeadersPlugin);
  await fastify.register(csrfPlugin);
  await fastify.register(fastifyWebsocket);

  // Health check
  fastify.get('/api/health', async () => ({ status: 'ok', timestamp: new Date().toISOString() }));

  // Routes
  await fastify.register(authRoutes);
  await fastify.register(serverRoutes);
  await fastify.register(consoleRoutes);
  await fastify.register(whitelistRoutes);
  await fastify.register(banRoutes);
  await fastify.register(backupRoutes);
  await fastify.register(backupJobRoutes);
  await fastify.register(modRoutes);
  await fastify.register(crashRoutes);
  await fastify.register(statsRoutes);
  await fastify.register(auditRoutes);
  await fastify.register(settingsRoutes);
  await fastify.register(userRoutes);

  // WebSocket
  await fastify.register(consoleWsHandler);

  return fastify;
}
