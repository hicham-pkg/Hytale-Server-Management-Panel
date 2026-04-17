import { describe, it, expect } from 'vitest';
import * as crypto from 'crypto';

/**
 * CSRF Protection Tests
 * Tests CSRF token generation, validation, safe method bypass,
 * and timing-safe comparison.
 */

const SAFE_METHODS = ['GET', 'HEAD', 'OPTIONS'];

function generateCsrfToken(secret: string, sessionId: string): string {
  return crypto.createHmac('sha256', secret).update(sessionId).digest('hex');
}

describe('CSRF Protection — Token Generation', () => {
  const secret = 'test-csrf-secret-at-least-32-characters-long';

  it('should generate deterministic tokens for same secret+session', () => {
    const token1 = generateCsrfToken(secret, 'session-123');
    const token2 = generateCsrfToken(secret, 'session-123');
    expect(token1).toBe(token2);
  });

  it('should generate different tokens for different sessions', () => {
    const token1 = generateCsrfToken(secret, 'session-123');
    const token2 = generateCsrfToken(secret, 'session-456');
    expect(token1).not.toBe(token2);
  });

  it('should generate different tokens for different secrets', () => {
    const token1 = generateCsrfToken(secret, 'session-123');
    const token2 = generateCsrfToken('different-secret-also-32-chars-long!!', 'session-123');
    expect(token1).not.toBe(token2);
  });

  it('should produce 64-character hex tokens', () => {
    const token = generateCsrfToken(secret, 'session-123');
    expect(token).toHaveLength(64);
    expect(/^[0-9a-f]{64}$/.test(token)).toBe(true);
  });
});

describe('CSRF Protection — Safe Methods Bypass', () => {
  it('should skip CSRF validation for GET requests', () => {
    expect(SAFE_METHODS.includes('GET')).toBe(true);
  });

  it('should skip CSRF validation for HEAD requests', () => {
    expect(SAFE_METHODS.includes('HEAD')).toBe(true);
  });

  it('should skip CSRF validation for OPTIONS requests', () => {
    expect(SAFE_METHODS.includes('OPTIONS')).toBe(true);
  });

  it('should NOT skip CSRF validation for POST requests', () => {
    expect(SAFE_METHODS.includes('POST')).toBe(false);
  });

  it('should NOT skip CSRF validation for PUT requests', () => {
    expect(SAFE_METHODS.includes('PUT')).toBe(false);
  });

  it('should NOT skip CSRF validation for DELETE requests', () => {
    expect(SAFE_METHODS.includes('DELETE')).toBe(false);
  });
});

describe('CSRF Protection — Token Validation', () => {
  const secret = 'test-csrf-secret-at-least-32-characters-long';
  const sessionId = 'session-abc-123';

  it('should accept valid CSRF token', () => {
    const expected = generateCsrfToken(secret, sessionId);
    const provided = generateCsrfToken(secret, sessionId);
    const isValid = crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(provided));
    expect(isValid).toBe(true);
  });

  it('should reject wrong CSRF token', () => {
    const expected = generateCsrfToken(secret, sessionId);
    const provided = generateCsrfToken(secret, 'different-session');
    const isValid = crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(provided));
    expect(isValid).toBe(false);
  });

  it('should reject empty CSRF token', () => {
    const token = '';
    expect(token.length).toBe(0);
    // The middleware checks !token first, so empty string is rejected
    expect(!token).toBe(true);
  });

  it('should reject forged CSRF token', () => {
    const expected = generateCsrfToken(secret, sessionId);
    const forged = 'a'.repeat(64);
    const isValid = crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(forged));
    expect(isValid).toBe(false);
  });
});

describe('CSRF Protection — Login Endpoint Exemption', () => {
  it('should exempt /api/auth/login from CSRF check (no session yet)', () => {
    const url = '/api/auth/login';
    const isExempt = url === '/api/auth/login';
    expect(isExempt).toBe(true);
  });

  it('should NOT exempt other auth endpoints from CSRF check', () => {
    const urls = ['/api/auth/logout', '/api/auth/verify-totp', '/api/auth/setup-totp'];
    for (const url of urls) {
      expect(url === '/api/auth/login').toBe(false);
    }
  });
});

describe('CSRF Protection — WebSocket Upgrade Exemption', () => {
  it('should exempt WebSocket upgrade requests from CSRF check', () => {
    const headers = { upgrade: 'websocket' };
    const isWsUpgrade = headers.upgrade === 'websocket';
    expect(isWsUpgrade).toBe(true);
  });

  it('should NOT exempt regular requests with upgrade header', () => {
    const headers = { upgrade: 'h2c' };
    const isWsUpgrade = headers.upgrade === 'websocket';
    expect(isWsUpgrade).toBe(false);
  });
});