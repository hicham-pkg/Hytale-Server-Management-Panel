import { beforeEach, describe, expect, it, vi } from 'vitest';
import { WS_CAPTURE_POLL_INTERVAL_MS } from '@hytale-panel/shared';

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
  emit: (event: string, ...args: unknown[]) => Promise<void>;
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
    async emit(event: string, ...args: unknown[]) {
      for (const handler of listeners.get(event) ?? []) {
        await handler(...args);
      }
    },
  };
}

function sentPayloads(socket: MockSocket): any[] {
  return socket.send.mock.calls.map(([payload]) => JSON.parse(payload));
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
    vi.useRealTimers();
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

    await sockets[0].emit('close');
    await sockets[1].emit('close');
    await sockets[2].emit('close');
  });

  it('revalidates the session on command messages and closes expired sessions', async () => {
    getConfigMock.mockReturnValue({
      nodeEnv: 'production',
      wsAllowedOrigins: 'https://panel.example.com',
    });
    validateSessionMock
      .mockResolvedValueOnce({
        valid: true,
        user: { id: 'user-1', username: 'admin', role: 'admin' },
      })
      .mockResolvedValueOnce({
        valid: false,
      });

    const { handler } = await loadWsHandler();
    const socket = createMockSocket();

    await handler(socket, {
      headers: { origin: 'https://panel.example.com' },
      cookies: { hytale_session: 'session-1' },
      ip: '127.0.0.1',
    });

    await socket.emit('message', Buffer.from(JSON.stringify({ type: 'command', data: 'save' })));

    expect(sendConsoleCommandMock).not.toHaveBeenCalled();
    expect(socket.send).toHaveBeenCalledWith(JSON.stringify({ type: 'error', message: 'Session expired' }));
    expect(socket.close).toHaveBeenCalledWith(4001, 'Unauthorized');
  });

  it('returns a specific parse error for malformed JSON messages', async () => {
    getConfigMock.mockReturnValue({
      nodeEnv: 'production',
      wsAllowedOrigins: 'https://panel.example.com',
    });
    validateSessionMock.mockResolvedValue({
      valid: true,
      user: { id: 'user-1', username: 'admin', role: 'admin' },
    });

    const { handler } = await loadWsHandler();
    const socket = createMockSocket();

    await handler(socket, {
      headers: { origin: 'https://panel.example.com' },
      cookies: { hytale_session: 'session-1' },
      ip: '127.0.0.1',
    });

    await socket.emit('message', Buffer.from('{invalid-json'));

    expect(sentPayloads(socket)).toContainEqual({ type: 'error', message: 'Malformed WebSocket JSON payload' });
    expect(sentPayloads(socket)).not.toContainEqual({ type: 'error', message: 'Invalid message format' });
  });

  it('returns a specific validation error for malformed WebSocket payloads', async () => {
    getConfigMock.mockReturnValue({
      nodeEnv: 'production',
      wsAllowedOrigins: 'https://panel.example.com',
    });
    validateSessionMock.mockResolvedValue({
      valid: true,
      user: { id: 'user-1', username: 'admin', role: 'admin' },
    });

    const { handler } = await loadWsHandler();
    const socket = createMockSocket();

    await handler(socket, {
      headers: { origin: 'https://panel.example.com' },
      cookies: { hytale_session: 'session-1' },
      ip: '127.0.0.1',
    });

    await socket.emit('message', Buffer.from(JSON.stringify({ type: 'command', data: '' })));

    expect(sentPayloads(socket)).toContainEqual({ type: 'error', message: 'Malformed WebSocket message payload' });
  });

  it('marks console stream degraded when helper capture is unavailable', async () => {
    getConfigMock.mockReturnValue({
      nodeEnv: 'production',
      wsAllowedOrigins: 'https://panel.example.com',
    });
    validateSessionMock.mockResolvedValue({
      valid: true,
      user: { id: 'user-1', username: 'admin', role: 'admin' },
    });
    const { handler } = await loadWsHandler();
    const { HelperUnavailableError } = await import('../../packages/api/src/services/helper-client');
    captureConsoleOutputMock.mockRejectedValue(
      new HelperUnavailableError('console.capturePane', 'helper socket unavailable')
    );
    const socket = createMockSocket();

    await handler(socket, {
      headers: { origin: 'https://panel.example.com' },
      cookies: { hytale_session: 'session-1' },
      ip: '127.0.0.1',
    });

    await socket.emit('message', Buffer.from(JSON.stringify({ type: 'subscribe' })));

    const payloads = sentPayloads(socket);
    expect(payloads).toContainEqual({ type: 'statusChange', status: 'degraded' });
    expect(payloads).toContainEqual({
      type: 'error',
      message: 'Helper unavailable: console capture temporarily degraded',
    });
    expect(payloads).not.toContainEqual({ type: 'error', message: 'Malformed WebSocket message payload' });

    await socket.emit('close');
  });

  it('returns explicit command execution errors for runtime failures', async () => {
    getConfigMock.mockReturnValue({
      nodeEnv: 'production',
      wsAllowedOrigins: 'https://panel.example.com',
    });
    validateSessionMock.mockResolvedValue({
      valid: true,
      user: { id: 'user-1', username: 'admin', role: 'admin' },
    });
    sendConsoleCommandMock.mockRejectedValue(new Error('tmux write failed'));

    const { handler } = await loadWsHandler();
    const socket = createMockSocket();

    await handler(socket, {
      headers: { origin: 'https://panel.example.com' },
      cookies: { hytale_session: 'session-1' },
      ip: '127.0.0.1',
    });

    await socket.emit('message', Buffer.from(JSON.stringify({ type: 'command', data: 'save-all' })));

    expect(sentPayloads(socket)).toContainEqual({
      type: 'error',
      message: 'Command execution failed: tmux write failed',
    });
    expect(sentPayloads(socket)).toContainEqual({
      type: 'commandResult',
      success: false,
      message: 'Command execution failed: tmux write failed',
    });
  });

  it('does not overlap capture polling when a prior poll is still in-flight', async () => {
    vi.useFakeTimers();

    getConfigMock.mockReturnValue({
      nodeEnv: 'production',
      wsAllowedOrigins: 'https://panel.example.com',
    });
    validateSessionMock.mockResolvedValue({
      valid: true,
      user: { id: 'user-1', username: 'admin', role: 'admin' },
    });

    let resolveFirstPoll:
      | ((value: { success: boolean; lines: string[] }) => void)
      | null = null;
    captureConsoleOutputMock
      .mockResolvedValueOnce({ success: true, lines: ['line-1'] })
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveFirstPoll = resolve as (value: { success: boolean; lines: string[] }) => void;
          })
      )
      .mockResolvedValue({ success: true, lines: ['line-1', 'line-2'] });

    const { handler } = await loadWsHandler();
    const socket = createMockSocket();

    await handler(socket, {
      headers: { origin: 'https://panel.example.com' },
      cookies: { hytale_session: 'session-1' },
      ip: '127.0.0.1',
    });

    await socket.emit('message', Buffer.from(JSON.stringify({ type: 'subscribe' })));
    await vi.advanceTimersByTimeAsync(WS_CAPTURE_POLL_INTERVAL_MS);

    expect(captureConsoleOutputMock).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(WS_CAPTURE_POLL_INTERVAL_MS * 4);
    expect(captureConsoleOutputMock).toHaveBeenCalledTimes(2);

    resolveFirstPoll?.({ success: true, lines: ['line-1', 'line-2'] });
    await vi.advanceTimersByTimeAsync(WS_CAPTURE_POLL_INTERVAL_MS);
    expect(captureConsoleOutputMock).toHaveBeenCalledTimes(3);

    await socket.emit('close');
  });

  it('streams appended lines when the capture window stays at 200 lines', async () => {
    vi.useFakeTimers();

    getConfigMock.mockReturnValue({
      nodeEnv: 'production',
      wsAllowedOrigins: 'https://panel.example.com',
    });
    validateSessionMock.mockResolvedValue({
      valid: true,
      user: { id: 'user-1', username: 'admin', role: 'admin' },
    });

    const initialLines = Array.from({ length: 200 }, (_, i) => `line-${i + 1}`);
    const shiftedLines = [...initialLines.slice(1), 'line-201'];

    captureConsoleOutputMock
      .mockResolvedValueOnce({ success: true, lines: initialLines })
      .mockResolvedValueOnce({ success: true, lines: shiftedLines });

    const { handler } = await loadWsHandler();
    const socket = createMockSocket();

    await handler(socket, {
      headers: { origin: 'https://panel.example.com' },
      cookies: { hytale_session: 'session-1' },
      ip: '127.0.0.1',
    });

    await socket.emit('message', Buffer.from(JSON.stringify({ type: 'subscribe' })));
    await vi.advanceTimersByTimeAsync(WS_CAPTURE_POLL_INTERVAL_MS);

    const logMessages = socket.send.mock.calls
      .map(([payload]) => JSON.parse(payload))
      .filter((payload) => payload.type === 'log');

    expect(logMessages[0]?.lines).toEqual(initialLines);
    expect(logMessages[1]?.lines).toEqual(['line-201']);

    await socket.emit('close');
  });
});
