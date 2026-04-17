import { describe, it, expect } from 'vitest';
import * as crypto from 'crypto';

const HMAC_TIMESTAMP_TOLERANCE_SEC = 30;

function computeHmac(secret: string, operation: string, params: string, timestamp: number, nonce: string): string {
  const payload = `${timestamp}:${nonce}:${operation}:${params}`;
  return crypto.createHmac('sha256', secret).update(payload).digest('hex');
}

function validateTimestamp(timestamp: number): boolean {
  const now = Math.floor(Date.now() / 1000);
  return Math.abs(now - timestamp) <= HMAC_TIMESTAMP_TOLERANCE_SEC;
}

describe('HMAC Authentication', () => {
  const secret = 'test-secret-key-at-least-32-chars-long';

  it('should generate valid HMAC signatures', () => {
    const ts = Math.floor(Date.now() / 1000);
    const nonce = crypto.randomUUID();
    const sig = computeHmac(secret, 'server.start', '{}', ts, nonce);
    expect(sig).toHaveLength(64);
    expect(/^[0-9a-f]{64}$/.test(sig)).toBe(true);
  });

  it('should produce different signatures for different operations', () => {
    const ts = Math.floor(Date.now() / 1000);
    const nonce = crypto.randomUUID();
    const sig1 = computeHmac(secret, 'server.start', '{}', ts, nonce);
    const sig2 = computeHmac(secret, 'server.stop', '{}', ts, nonce);
    expect(sig1).not.toBe(sig2);
  });

  it('should produce different signatures for different params', () => {
    const ts = Math.floor(Date.now() / 1000);
    const nonce = crypto.randomUUID();
    const sig1 = computeHmac(secret, 'server.sendCommand', '{"command":"save"}', ts, nonce);
    const sig2 = computeHmac(secret, 'server.sendCommand', '{"command":"stop"}', ts, nonce);
    expect(sig1).not.toBe(sig2);
  });

  it('should produce different signatures for different secrets', () => {
    const ts = Math.floor(Date.now() / 1000);
    const nonce = crypto.randomUUID();
    const sig1 = computeHmac(secret, 'server.start', '{}', ts, nonce);
    const sig2 = computeHmac('different-secret-key-also-32-chars', 'server.start', '{}', ts, nonce);
    expect(sig1).not.toBe(sig2);
  });

  it('should accept timestamps within tolerance', () => {
    const now = Math.floor(Date.now() / 1000);
    expect(validateTimestamp(now)).toBe(true);
    expect(validateTimestamp(now - 10)).toBe(true);
    expect(validateTimestamp(now + 10)).toBe(true);
    expect(validateTimestamp(now - HMAC_TIMESTAMP_TOLERANCE_SEC)).toBe(true);
  });

  it('should reject timestamps outside tolerance', () => {
    const now = Math.floor(Date.now() / 1000);
    expect(validateTimestamp(now - HMAC_TIMESTAMP_TOLERANCE_SEC - 1)).toBe(false);
    expect(validateTimestamp(now + HMAC_TIMESTAMP_TOLERANCE_SEC + 1)).toBe(false);
    expect(validateTimestamp(now - 300)).toBe(false);
  });
});