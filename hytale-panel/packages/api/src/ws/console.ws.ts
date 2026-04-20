import type { FastifyInstance } from 'fastify';
import {
  ClientWsMessageSchema,
  WS_HEARTBEAT_INTERVAL_MS,
  WS_CAPTURE_POLL_INTERVAL_MS,
  WS_MAX_CONNECTIONS_PER_SESSION,
} from '@hytale-panel/shared';
import { validateSession } from '../services/auth.service';
import { captureConsoleOutput, sendConsoleCommand } from '../services/console.service';
import { logAudit } from '../services/audit.service';
import { sanitizeLogLines } from '../utils/sanitize';
import { getConfig } from '../config';
import type { ServerWsMessage } from '@hytale-panel/shared';

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

    const sessionResult = await validateSession(sessionId);
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
    let pollInterval: ReturnType<typeof setInterval> | null = null;
    let heartbeatInterval: ReturnType<typeof setInterval> | null = null;
    let lastCaptureLines: string[] = [];
    let messageCount = 0;
    let lastMessageReset = Date.now();
    let connectionReleased = false;

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

    const sendMsg = (msg: ServerWsMessage) => {
      try {
        if (socket.readyState === 1) {
          socket.send(JSON.stringify(msg));
        }
      } catch {
        // Socket may have closed
      }
    };

    const ensureSessionValidOrClose = async (): Promise<boolean> => {
      const latest = await validateSession(sessionId);
      if (!latest.valid || !latest.user) {
        sendMsg({ type: 'error', message: 'Session expired' });
        socket.close(4001, 'Unauthorized');
        return false;
      }

      user = latest.user;
      return true;
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

      try {
        const data = JSON.parse(rawData.toString());
        const message = ClientWsMessageSchema.parse(data);

        switch (message.type) {
          case 'subscribe': {
            if (!(await ensureSessionValidOrClose())) {
              return;
            }

            if (subscribed) return;
            subscribed = true;

            // Initial capture
            const initial = await captureConsoleOutput(200);
            if (initial.success) {
              lastCaptureLines = initial.lines;
              sendMsg({ type: 'log', lines: initial.lines, timestamp: new Date().toISOString() });
            }

            // Start polling for new output.
            pollInterval = setInterval(async () => {
              try {
                const capture = await captureConsoleOutput(200);
                if (!capture.success) return;

                const newLines = computeAppendedLines(lastCaptureLines, capture.lines);
                lastCaptureLines = capture.lines;
                if (newLines.length > 0) {
                  sendMsg({ type: 'log', lines: sanitizeLogLines(newLines), timestamp: new Date().toISOString() });
                }
              } catch {
                // Ignore polling errors
              }
            }, WS_CAPTURE_POLL_INTERVAL_MS);

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

            const result = await sendConsoleCommand(message.data);

            await logAudit({
              userId: user.id,
              action: 'console.command',
              target: message.data,
              ipAddress: request.ip,
              success: result.success,
            });

            sendMsg({
              type: 'commandResult',
              success: result.success,
              message: result.message,
            });
            break;
          }

          case 'pong': {
            // Heartbeat response — no action needed
            break;
          }
        }
      } catch {
        sendMsg({ type: 'error', message: 'Invalid message format' });
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
      if (pollInterval) clearInterval(pollInterval);
      if (heartbeatInterval) clearInterval(heartbeatInterval);
      releaseConnection();
    });

    socket.on('error', () => {
      if (pollInterval) clearInterval(pollInterval);
      if (heartbeatInterval) clearInterval(heartbeatInterval);
      releaseConnection();
    });
  });
}
