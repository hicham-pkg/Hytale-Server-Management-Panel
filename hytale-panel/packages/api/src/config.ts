import { z } from 'zod';

const ConfigSchema = z.object({
  databaseUrl: z.string().url(),
  apiHost: z.string().default('0.0.0.0'),
  apiPort: z.coerce.number().default(4000),
  nodeEnv: z.enum(['development', 'production', 'test']).default('production'),
  // Sessions are DB-backed opaque tokens (see `sessions` table in db/schema.ts
  // and utils/session-cookie.ts). SESSION_SECRET is reserved for future cookie
  // signing and is not consumed at runtime; still required at startup so
  // activating signing later doesn't become a breaking env change.
  sessionSecret: z.string().min(32),
  sessionMaxAgeHours: z.coerce.number().default(4),
  sessionIdleTimeoutMinutes: z.coerce.number().default(60),
  adminSessionIdleTimeoutMinutes: z.coerce.number().default(15),
  cookieDomain: z.string().optional(),
  csrfSecret: z.string().min(32),
  helperSocketPath: z.string().default('/run/hytale-helper/hytale-helper.sock'),
  helperHmacSecret: z.string().min(32),
  trustProxy: z.string().default('loopback, linklocal, uniquelocal'),
  corsOrigin: z.string().default(''),
  wsAllowedOrigins: z.string().default(''),
  maxFailedLogins: z.coerce.number().default(10),
  lockoutDurationMinutes: z.coerce.number().default(30),
  loginRateLimitMax: z.coerce.number().default(5),
  loginRateLimitWindowMs: z.coerce.number().default(900_000),
  globalRateLimitMax: z.coerce.number().default(100),
  globalRateLimitWindowMs: z.coerce.number().default(60_000),
  auditLogRetentionDays: z.coerce.number().default(90),
  crashLogRetentionDays: z.coerce.number().default(30),
  modUploadStagingPath: z.string().startsWith('/').default('/opt/hytale-panel-data/mod-upload-staging'),
  maxModUploadSizeMb: z.coerce.number().int().min(1).max(1024).default(150),
});

export type AppConfig = z.infer<typeof ConfigSchema>;

let _config: AppConfig | null = null;

export function getConfig(): AppConfig {
  if (!_config) {
    _config = ConfigSchema.parse({
      databaseUrl: process.env.DATABASE_URL,
      apiHost: process.env.API_HOST,
      apiPort: process.env.API_PORT,
      nodeEnv: process.env.NODE_ENV,
      sessionSecret: process.env.SESSION_SECRET,
      sessionMaxAgeHours: process.env.SESSION_MAX_AGE_HOURS,
      sessionIdleTimeoutMinutes: process.env.SESSION_IDLE_TIMEOUT_MINUTES,
      adminSessionIdleTimeoutMinutes: process.env.ADMIN_SESSION_IDLE_TIMEOUT_MINUTES,
      cookieDomain: process.env.COOKIE_DOMAIN,
      csrfSecret: process.env.CSRF_SECRET,
      helperSocketPath: process.env.HELPER_SOCKET_PATH,
      helperHmacSecret: process.env.HELPER_HMAC_SECRET,
      trustProxy: process.env.TRUST_PROXY,
      corsOrigin: process.env.CORS_ORIGIN,
      wsAllowedOrigins: process.env.WS_ALLOWED_ORIGINS,
      maxFailedLogins: process.env.MAX_FAILED_LOGINS,
      lockoutDurationMinutes: process.env.LOCKOUT_DURATION_MINUTES,
      loginRateLimitMax: process.env.LOGIN_RATE_LIMIT_MAX,
      loginRateLimitWindowMs: process.env.LOGIN_RATE_LIMIT_WINDOW_MS,
      globalRateLimitMax: process.env.GLOBAL_RATE_LIMIT_MAX,
      globalRateLimitWindowMs: process.env.GLOBAL_RATE_LIMIT_WINDOW_MS,
      auditLogRetentionDays: process.env.AUDIT_LOG_RETENTION_DAYS,
      crashLogRetentionDays: process.env.CRASH_LOG_RETENTION_DAYS,
      modUploadStagingPath: process.env.MOD_UPLOAD_STAGING_PATH,
      maxModUploadSizeMb: process.env.MAX_MOD_UPLOAD_SIZE_MB,
    });
  }
  return _config;
}
