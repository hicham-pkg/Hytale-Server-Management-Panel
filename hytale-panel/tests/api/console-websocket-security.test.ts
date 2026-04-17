import { beforeEach, describe, expect, it, vi } from 'vitest';

const getConfigMock = vi.fn();
const validateSessionMock = vi.fn();
const captureConsoleOutputMock = vi.fn();
const sendConsoleCommandMock = vi.fn();
const logAuditMock = vi.fn();

vi.mock('../../packages/api/src/config', () => ({
  getConfig: getConfigMock,
}));

vi.mock('../../packages/api/src/services/auth.service', () => ({
  validateSession: validateSessionMock,
}));

vi.mock('../../packages/api/src/services/console.service', () => ({
  captureConsoleOutput: captureConsoleOutputMock,
  sendConsoleCommand: sendConsoleCommandMock,
}));

vi.mock('../../packages/api/src/services/audit.service', () => ({
  logAudit: logAuditMock,
}));

vi.mock('../../packages/api/src/utils/sanitize', () => ({
  sanitizeLogLines: (lines: string[]) => lines,
}));

interface MockSocket {
  readyState: number;
  send: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  on: ReturnType<typeof vi.fn>;
  emit: (event: string, ...args: unknown[]) => void;
}

function createMockSocket(): MockSocket {
  const listeners = new Map<string, Array<(...args: unknown[]) => void>>();

  return {
    readyState: 1,
    send: vi.fn(),
    close: vi.fn(),
    on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
      const existing = listeners.get(event) ?? [];
      existing.push(handler);
      listeners.set(event, existing);
    }),
    emit(event: string, ...args: unknown[]) {
      for (const handler of listeners.get(event) ?? []) {
        handler(...args);
      }
    },
  };
}

async function loadWsHandler() {
  vi.resetModules();
  const { consoleWsHandler } = await import('../../packages/api/src/ws/console.ws');

  let registeredHandler:
    | ((socket: MockSocket, request: Record<string, any>) => Promise<void>)
    | null = null;

  const fastify = {
    get: vi.fn((_path: string, _opts: unknown, handler: typeof registeredHandler) => {
      registeredHandler = handler;
    }),
    log: {
      warn: vi.fn(),
    },
  };

  await consoleWsHandler(fastify as any);

  if (!registeredHandler) {
    throw new Error('Console WebSocket handler was not registered');
  }

  return { handler: registeredHandler, fastify };
}

describe('Console WebSocket Security', () => {
  beforeEach(() => {
    getConfigMock.mockReset();
    validateSessionMock.mockReset();
    captureConsoleOutputMock.mockReset();
    sendConsoleCommandMock.mockReset();
    logAuditMock.mockReset();
  });

  it('fails closed in production when WS_ALLOWED_ORIGINS is not configured', async () => {
    getConfigMock.mockReturnValue({
      nodeEnv: 'production',
      wsAllowedOrigins: '',
    });

    const { handler, fastify } = await loadWsHandler();
    const socket = createMockSocket();

    await handler(socket, {
      headers: { origin: 'https://panel.example.com' },
      cookies: { hytale_session: 'session-1' },
      ip: '127.0.0.1',
    });

    expect(fastify.log.warn).toHaveBeenCalledWith(
      'WS_ALLOWED_ORIGINS is not configured in production — rejecting console WebSocket connection'
    );
    expect(socket.send).toHaveBeenCalledWith(
      JSON.stringify({ type: 'error', message: 'Console WebSocket origin policy is not configured' })
    );
    expect(socket.close).toHaveBeenCalledWith(4003, 'Origin not allowed');
    expect(validateSessionMock).not.toHaveBeenCalled();
  });

  it('enforces the per-session console WebSocket connection limit', async () => {
    getConfigMock.mockReturnValue({
      nodeEnv: 'production',
      wsAllowedOrigins: 'https://panel.example.com',
    });
    validateSessionMock.mockResolvedValue({
      valid: true,
      user: { id: 'user-1', username: 'admin', role: 'admin' },
    });

    const { handler } = await loadWsHandler();
    const request = {
      headers: { origin: 'https://panel.example.com' },
      cookies: { hytale_session: 'session-1' },
      ip: '127.0.0.1',
    };

    const sockets = [createMockSocket(), createMockSocket(), createMockSocket(), createMockSocket()];

    await handler(sockets[0], request);
    await handler(sockets[1], request);
    await handler(sockets[2], request);
    await handler(sockets[3], request);

    expect(sockets[3].send).toHaveBeenCalledWith(
      JSON.stringify({ type: 'error', message: 'Too many active console sessions' })
    );
    expect(sockets[3].close).toHaveBeenCalledWith(4008, 'Connection limit exceeded');

    sockets[0].emit('close');
    sockets[1].emit('close');
    sockets[2].emit('close');
  });
});
