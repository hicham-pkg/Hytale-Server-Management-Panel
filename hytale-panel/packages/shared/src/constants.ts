/** Maximum length for console commands sent to the game server */
export const MAX_COMMAND_LENGTH = 200;

/** Regex for allowed characters in console commands — no shell metacharacters */
export const COMMAND_CHAR_ALLOWLIST = /^[a-zA-Z0-9 _\-\.@:\/]+$/;

/** Regex for valid player names (conservative) */
export const PLAYER_NAME_REGEX = /^[a-zA-Z0-9_]{1,32}$/;

/** Regex for valid backup labels */
export const BACKUP_LABEL_REGEX = /^[a-zA-Z0-9_\-]{1,50}$/;

/** Regex for valid backup filenames */
export const BACKUP_FILENAME_REGEX = /^[a-zA-Z0-9_\-\.]+\.tar\.gz$/;

/** UUID v4 regex */
export const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Maximum lines for log reading */
export const MAX_LOG_LINES = 1000;

/** Maximum lines for capture-pane */
export const MAX_CAPTURE_LINES = 500;

/** HMAC timestamp tolerance in seconds */
export const HMAC_TIMESTAMP_TOLERANCE_SEC = 30;

/** Session defaults */
export const DEFAULT_SESSION_MAX_AGE_HOURS = 4;
export const DEFAULT_SESSION_IDLE_TIMEOUT_MINUTES = 60;
export const DEFAULT_ADMIN_SESSION_IDLE_TIMEOUT_MINUTES = 15;

/** Account lockout defaults */
export const DEFAULT_MAX_FAILED_LOGINS = 10;
export const DEFAULT_LOCKOUT_DURATION_MINUTES = 30;

/** WebSocket limits */
export const WS_MAX_CONNECTIONS_PER_SESSION = 3;
export const WS_MESSAGE_RATE_LIMIT_PER_SEC = 10;
export const WS_HEARTBEAT_INTERVAL_MS = 30_000;
export const WS_CAPTURE_POLL_INTERVAL_MS = 500;

/** Allowed helper operations */
export const HELPER_OPERATIONS = [
  'helper.ping',
  'server.start',
  'server.stop',
  'server.restart',
  'server.status',
  'server.sendCommand',
  'logs.read',
  'console.capturePane',
  'whitelist.read',
  'whitelist.write',
  'bans.read',
  'bans.write',
  'backup.create',
  'backup.list',
  'backup.restore',
  'backup.delete',
  'backup.hash',
  'backup.operationStatus',
  'stats.system',
  'stats.process',
] as const;

export type HelperOperation = (typeof HELPER_OPERATIONS)[number];

/** User roles */
export const ROLES = ['admin', 'readonly'] as const;
export type UserRole = (typeof ROLES)[number];

/** Crash severity levels */
export const SEVERITIES = ['info', 'warning', 'error', 'critical'] as const;
export type Severity = (typeof SEVERITIES)[number];

/** Crash detection patterns */
export const CRASH_PATTERNS = [
  { pattern: 'world crashed', severity: 'critical' as Severity, summary: 'World crash detected' },
  { pattern: 'no default world configured', severity: 'error' as Severity, summary: 'No default world configured' },
  { pattern: 'Out of memory', severity: 'critical' as Severity, summary: 'Out of memory (OOM) event' },
  { pattern: 'Killed process', severity: 'critical' as Severity, summary: 'Process killed (likely OOM)' },
  { pattern: 'oom-kill', severity: 'critical' as Severity, summary: 'OOM killer invoked' },
  { pattern: 'async chunk', severity: 'warning' as Severity, summary: 'Async chunk loading warning' },
  { pattern: 'entity warning', severity: 'warning' as Severity, summary: 'Entity system warning' },
  { pattern: 'Exception', severity: 'error' as Severity, summary: 'Unhandled exception detected' },
  { pattern: 'FATAL', severity: 'critical' as Severity, summary: 'Fatal error detected' },
  { pattern: 'Error', severity: 'warning' as Severity, summary: 'Error message in logs' },
] as const;
