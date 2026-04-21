import type { FastifyInstance } from 'fastify';
import {
  ClientWsMessageSchema,
  WS_HEARTBEAT_INTERVAL_MS,
  WS_CAPTURE_POLL_INTERVAL_MS,
  WS_MAX_CONNECTIONS_PER_SESSION,
} from '@hytale-panel/shared';
import { ZodError } from 'zod';
import { validateSession } from '../services/auth.service';
import { captureConsoleOutput, sendConsoleCommand } from '../services/console.service';
import { logAudit } from '../services/audit.service';
import { sanitizeLogLines } from '../utils/sanitize';
import { getConfig } from '../config';
import type { ServerWsMessage } from '@hytale-panel/shared';
import { isHelperUnavailableError } from '../services/helper-client';

/**
 * Parse the wsAllowedOrigins config string into a Set of allowed origins.
 */
function parseAllowedOrigins(raw: string): Set<string> {
  if (!raw) return new Set();
  return new Set(
    raw
      .split(',')
      .map((o) => o.trim().toLowerCase())
      .filter(Boolean)
  );
}

/**
 * Compute lines appended to a moving capture window.
 * Uses suffix/prefix overlap so fixed-size captures still stream correctly
 * after the pane reaches its max line count.
 */
function computeAppendedLines(previousLines: string[], currentLines: string[]): string[] {
  if (previousLines.length === 0) {
    return currentLines;
  }

  const maxOverlap = Math.min(previousLines.length, currentLines.length);
  for (let overlap = maxOverlap; overlap > 0; overlap -= 1) {
    let matches = true;
    for (let index = 0; index < overlap; index += 1) {
      if (previousLines[previousLines.length - overlap + index] !== currentLines[index]) {
        matches = false;
        break;
      }
    }

    if (matches) {
      return currentLines.slice(overlap);
    }
  }

  // No overlap (window jumped): emit current capture to resync.
  return currentLines;
}

const activeConnectionsBySession = new Map<string, number>();
const DEGRADED_CAPTURE_POLL_INTERVAL_MS = Math.max(
  WS_CAPTURE_POLL_INTERVAL_MS * 3,
  WS_CAPTURE_POLL_INTERVAL_MS + 500
);

export async function consoleWsHandler(fastify: FastifyInstance): Promise<void> {
  fastify.get('/ws/console', { websocket: true }, async (socket, request) => {
    const config = getConfig();

    // ─── Origin validation ─────────────────────────────────
    const allowedOrigins = parseAllowedOrigins(config.wsAllowedOrigins);
    if (allowedOrigins.size > 0) {
      const origin = (request.headers.origin ?? '').toLowerCase();
      if (!origin || !allowedOrigins.has(origin)) {
        fastify.log.warn(`WebSocket origin rejected: "${origin}" not in allowed list`);
        socket.send(JSON.stringify({ type: 'error', message: 'Origin not allowed' }));
        socket.close(4003, 'Origin not allowed');
        return;
      }
    } else if (config.nodeEnv === 'production') {
      fastify.log.warn('WS_ALLOWED_ORIGINS is not configured in production — rejecting console WebSocket connection');
      socket.send(JSON.stringify({ type: 'error', message: 'Console WebSocket origin policy is not configured' }));
      socket.close(4003, 'Origin not allowed');
      return;
    }

    // ─── Session authentication ────────────────────────────
    const sessionId = request.cookies?.['hytale_session'];
    if (!sessionId) {
      socket.send(JSON.stringify({ type: 'error', message: 'Authentication required' }));
      socket.close(4001, 'Unauthorized');
      return;
    }

    let sessionResult: Awaited<ReturnType<typeof validateSession>>;
    try {
      sessionResult = await validateSession(sessionId);
    } catch {
      socket.send(JSON.stringify({ type: 'error', message: 'Session validation failed' }));
      socket.close(1011, 'Session validation failed');
      return;
    }
    if (!sessionResult.valid || !sessionResult.user) {
      socket.send(JSON.stringify({ type: 'error', message: 'Invalid session' }));
      socket.close(4001, 'Unauthorized');
      return;
    }

    const currentConnections = activeConnectionsBySession.get(sessionId) ?? 0;
    if (currentConnections >= WS_MAX_CONNECTIONS_PER_SESSION) {
      socket.send(JSON.stringify({ type: 'error', message: 'Too many active console sessions' }));
      socket.close(4008, 'Connection limit exceeded');
      return;
    }
    activeConnectionsBySession.set(sessionId, currentConnections + 1);

    let user = sessionResult.user;
    let subscribed = false;
    let pollTimer: ReturnType<typeof setTimeout> | null = null;
    let heartbeatInterval: ReturnType<typeof setInterval> | null = null;
    let lastCaptureLines: string[] = [];
    let pollInFlight = false;
    let messageCount = 0;
    let lastMessageReset = Date.now();
    let connectionReleased = false;
    let consoleDegraded = false;
    let lastDegradedMessage: string | null = null;

    const releaseConnection = () => {
      if (connectionReleased) {
        return;
      }
      connectionReleased = true;

      const remaining = (activeConnectionsBySession.get(sessionId) ?? 1) - 1;
      if (remaining <= 0) {
        activeConnectionsBySession.delete(sessionId);
      } else {
        activeConnectionsBySession.set(sessionId, remaining);
      }
    };

    const closeWithError = (code: number, reason: string, message: string) => {
      sendMsg({ type: 'error', message });
      socket.close(code, reason);
    };

    const sendMsg = (msg: ServerWsMessage) => {
      try {
        if (socket.readyState === 1) {
          socket.send(JSON.stringify(msg));
        }
      } catch {
        // Socket may have closed
      }
    };

    const markConsoleHealthy = () => {
      if (!consoleDegraded) {
        return;
      }
      consoleDegraded = false;
      lastDegradedMessage = null;
      sendMsg({ type: 'statusChange', status: 'healthy' });
    };

    const markConsoleDegraded = (message: string) => {
      if (!consoleDegraded) {
        consoleDegraded = true;
        sendMsg({ type: 'statusChange', status: 'degraded' });
      }
      if (message !== lastDegradedMessage) {
        sendMsg({ type: 'error', message });
        lastDegradedMessage = message;
      }
    };

    const classifyConsoleRuntimeError = (error: unknown): string => {
      if (isHelperUnavailableError(error)) {
        return 'Helper unavailable: console capture temporarily degraded';
      }

      const message =
        typeof error === 'string'
          ? error
          : error instanceof Error
            ? error.message
            : '';
      if (message.toLowerCase().includes('helper')) {
        return 'Helper unavailable: console capture temporarily degraded';
      }
      if (message.toLowerCase().includes('tmux session not found')) {
        return 'Console runtime unavailable: server tmux session not found';
      }
      if (message) {
        return `Console capture failed: ${message}`;
      }

      return 'Console capture failed due to an internal runtime error';
    };

    const clearPollTimer = () => {
      if (!pollTimer) {
        return;
      }
      clearTimeout(pollTimer);
      pollTimer = null;
    };

    const scheduleCapturePoll = (run: () => Promise<void>, delayMs: number) => {
      clearPollTimer();
      if (!subscribed || socket.readyState !== 1) {
        return;
      }
      pollTimer = setTimeout(() => {
        pollTimer = null;
        void run();
      }, delayMs);
    };

    const ensureSessionValidOrClose = async (): Promise<boolean> => {
      try {
        const latest = await validateSession(sessionId);
        if (!latest.valid || !latest.user) {
          closeWithError(4001, 'Unauthorized', 'Session expired');
          return false;
        }

        user = latest.user;
        return true;
      } catch {
        closeWithError(1011, 'Session validation failed', 'Session validation failed');
        return false;
      }
    };

    sendMsg({ type: 'connected', serverStatus: 'checking' });

    // Rate limiting: max 10 messages per second
    const checkRateLimit = (): boolean => {
      const now = Date.now();
      if (now - lastMessageReset > 1000) {
        messageCount = 0;
        lastMessageReset = now;
      }
      messageCount++;
      return messageCount <= 10;
    };

    socket.on('message', async (rawData: Buffer | string) => {
      if (!checkRateLimit()) {
        sendMsg({ type: 'error', message: 'Rate limit exceeded' });
        return;
      }

      let message: ReturnType<typeof ClientWsMessageSchema.parse>;
      try {
        const data = JSON.parse(rawData.toString());
        message = ClientWsMessageSchema.parse(data);
      } catch (err) {
        if (err instanceof SyntaxError) {
          sendMsg({ type: 'error', message: 'Malformed WebSocket JSON payload' });
          return;
        }
        if (err instanceof ZodError) {
          sendMsg({ type: 'error', message: 'Malformed WebSocket message payload' });
          return;
        }
        sendMsg({ type: 'error', message: 'WebSocket message parsing failed' });
        return;
      }

      switch (message.type) {
        case 'subscribe': {
          if (!(await ensureSessionValidOrClose())) {
            return;
          }

          if (subscribed) return;
          subscribed = true;

          try {
            // Initial capture
            const initial = await captureConsoleOutput(200);
            if (initial.success) {
              lastCaptureLines = initial.lines;
              markConsoleHealthy();
              sendMsg({ type: 'log', lines: initial.lines, timestamp: new Date().toISOString() });
            } else {
              markConsoleDegraded(classifyConsoleRuntimeError(initial.error ?? 'Console capture failed'));
            }
          } catch (err) {
            markConsoleDegraded(classifyConsoleRuntimeError(err));
          }

          const runCapturePoll = async () => {
            if (pollInFlight || !subscribed || socket.readyState !== 1) {
              return;
            }

            pollInFlight = true;
            let nextDelayMs = WS_CAPTURE_POLL_INTERVAL_MS;
            try {
              const capture = await captureConsoleOutput(200);
              if (!capture.success) {
                markConsoleDegraded(classifyConsoleRuntimeError(capture.error ?? 'Console capture failed'));
                nextDelayMs = DEGRADED_CAPTURE_POLL_INTERVAL_MS;
                return;
              }

              markConsoleHealthy();
              const newLines = computeAppendedLines(lastCaptureLines, capture.lines);
              lastCaptureLines = capture.lines;
              if (newLines.length > 0) {
                sendMsg({ type: 'log', lines: sanitizeLogLines(newLines), timestamp: new Date().toISOString() });
              }
            } catch (err) {
              markConsoleDegraded(classifyConsoleRuntimeError(err));
              nextDelayMs = DEGRADED_CAPTURE_POLL_INTERVAL_MS;
            } finally {
              pollInFlight = false;
              scheduleCapturePoll(runCapturePoll, nextDelayMs);
            }
          };

          // Start polling for new output. Polling is single-flight so slow
          // helper captures cannot overlap and amplify degraded conditions.
          scheduleCapturePoll(runCapturePoll, WS_CAPTURE_POLL_INTERVAL_MS);

          break;
        }

        case 'command': {
          if (!(await ensureSessionValidOrClose())) {
            return;
          }

          // Only admins can send commands
          if (user.role !== 'admin') {
            sendMsg({ type: 'error', message: 'Insufficient permissions' });
            return;
          }

          try {
            const result = await sendConsoleCommand(message.data);

            await logAudit({
              userId: user.id,
              action: 'console.command',
              target: message.data,
              ipAddress: request.ip,
              success: result.success,
            });

            if (!result.success) {
              sendMsg({ type: 'error', message: `Command execution failed: ${result.message}` });
            }
            sendMsg({
              type: 'commandResult',
              success: result.success,
              message: result.message,
            });
          } catch (err) {
            const helperUnavailable = isHelperUnavailableError(err);
            const commandError = helperUnavailable
              ? 'Helper unavailable: command execution is degraded'
              : err instanceof Error && err.message
                ? `Command execution failed: ${err.message}`
                : 'Command execution failed due to an internal error';
            if (helperUnavailable) {
              markConsoleDegraded(commandError);
            }
            sendMsg({ type: 'error', message: commandError });
            sendMsg({
              type: 'commandResult',
              success: false,
              message: commandError,
            });
          }
          break;
        }

        case 'pong': {
          // Heartbeat response — no action needed
          break;
        }
      }
    });

    // Heartbeat
    heartbeatInterval = setInterval(() => {
      void (async () => {
        if (!(await ensureSessionValidOrClose())) {
          return;
        }
        sendMsg({ type: 'ping' });
      })();
    }, WS_HEARTBEAT_INTERVAL_MS);

    socket.on('close', () => {
      clearPollTimer();
      if (heartbeatInterval) clearInterval(heartbeatInterval);
      releaseConnection();
    });

    socket.on('error', () => {
      clearPollTimer();
      if (heartbeatInterval) clearInterval(heartbeatInterval);
      releaseConnection();
    });
  });
}
