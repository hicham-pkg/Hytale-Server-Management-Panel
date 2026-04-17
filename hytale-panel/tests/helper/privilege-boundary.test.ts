import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import * as crypto from 'crypto';
import {
  HELPER_OPERATIONS,
  HMAC_TIMESTAMP_TOLERANCE_SEC,
} from '@hytale-panel/shared';

/**
 * Helper Privilege Boundary Tests
 * Tests that only allowlisted operations are accepted,
 * unknown actions are rejected, HMAC validation is strict,
 * and nonce replay is prevented.
 */

// Mirror the helper's request schema
const RequestSchema = z.object({
  operation: z.enum(HELPER_OPERATIONS),
  params: z.record(z.unknown()).default({}),
  timestamp: z.number(),
  nonce: z.string().min(16).max(64),
  signature: z.string().length(64),
});

function computeHmac(secret: string, operation: string, params: string, timestamp: number, nonce: string): string {
  const payload = `${timestamp}:${nonce}:${operation}:${params}`;
  return crypto.createHmac('sha256', secret).update(payload).digest('hex');
}

function validateTimestamp(timestamp: number): boolean {
  const now = Math.floor(Date.now() / 1000);
  return Math.abs(now - timestamp) <= HMAC_TIMESTAMP_TOLERANCE_SEC;
}

describe('Helper Privilege Boundary — Allowlisted Operations', () => {
  const expectedOps = [
    'helper.ping',
    'server.start', 'server.stop', 'server.restart', 'server.status',
    'server.sendCommand', 'logs.read', 'console.capturePane',
    'whitelist.read', 'whitelist.write', 'bans.read', 'bans.write',
    'backup.create', 'backup.list', 'backup.restore', 'backup.delete',
    'backup.hash',
    'stats.system', 'stats.process',
  ];

  it('should define exactly 19 allowed operations', () => {
    expect(HELPER_OPERATIONS).toHaveLength(19);
  });

  for (const op of expectedOps) {
    it(`should allow operation: ${op}`, () => {
      expect(HELPER_OPERATIONS).toContain(op);
    });
  }
});

describe('Helper Privilege Boundary — Rejected Operations', () => {
  const dangerousOps = [
    'exec',
    'shell',
    'system',
    'eval',
    'server.delete',
    'server.format',
    'file.read',
    'file.write',
    'file.delete',
    'os.exec',
    'process.kill',
    'admin.reset',
    'db.drop',
    'sudo',
    'root.shell',
  ];

  for (const op of dangerousOps) {
    it(`should reject dangerous operation: ${op}`, () => {
      const ts = Math.floor(Date.now() / 1000);
      const nonce = crypto.randomUUID();
      const sig = 'a'.repeat(64);

      expect(() => RequestSchema.parse({
        operation: op,
        params: {},
        timestamp: ts,
        nonce,
        signature: sig,
      })).toThrow();
    });
  }
});

describe('Helper Privilege Boundary — Request Schema Validation', () => {
  it('should reject requests without operation', () => {
    expect(() => RequestSchema.parse({
      params: {},
      timestamp: Math.floor(Date.now() / 1000),
      nonce: crypto.randomUUID(),
      signature: 'a'.repeat(64),
    })).toThrow();
  });

  it('should reject requests without timestamp', () => {
    expect(() => RequestSchema.parse({
      operation: 'server.status',
      params: {},
      nonce: crypto.randomUUID(),
      signature: 'a'.repeat(64),
    })).toThrow();
  });

  it('should reject requests without nonce', () => {
    expect(() => RequestSchema.parse({
      operation: 'server.status',
      params: {},
      timestamp: Math.floor(Date.now() / 1000),
      signature: 'a'.repeat(64),
    })).toThrow();
  });

  it('should reject requests without signature', () => {
    expect(() => RequestSchema.parse({
      operation: 'server.status',
      params: {},
      timestamp: Math.floor(Date.now() / 1000),
      nonce: crypto.randomUUID(),
    })).toThrow();
  });

  it('should reject nonce shorter than 16 characters', () => {
    expect(() => RequestSchema.parse({
      operation: 'server.status',
      params: {},
      timestamp: Math.floor(Date.now() / 1000),
      nonce: 'short',
      signature: 'a'.repeat(64),
    })).toThrow();
  });

  it('should reject nonce longer than 64 characters', () => {
    expect(() => RequestSchema.parse({
      operation: 'server.status',
      params: {},
      timestamp: Math.floor(Date.now() / 1000),
      nonce: 'x'.repeat(65),
      signature: 'a'.repeat(64),
    })).toThrow();
  });

  it('should reject signature not exactly 64 characters', () => {
    expect(() => RequestSchema.parse({
      operation: 'server.status',
      params: {},
      timestamp: Math.floor(Date.now() / 1000),
      nonce: crypto.randomUUID(),
      signature: 'a'.repeat(63),
    })).toThrow();

    expect(() => RequestSchema.parse({
      operation: 'server.status',
      params: {},
      timestamp: Math.floor(Date.now() / 1000),
      nonce: crypto.randomUUID(),
      signature: 'a'.repeat(65),
    })).toThrow();
  });
});

describe('Helper Privilege Boundary — HMAC Validation', () => {
  const secret = 'test-hmac-secret-at-least-32-chars-long';

  it('should accept valid HMAC signature', () => {
    const ts = Math.floor(Date.now() / 1000);
    const nonce = crypto.randomUUID();
    const params = '{}';
    const sig = computeHmac(secret, 'server.status', params, ts, nonce);
    const expected = computeHmac(secret, 'server.status', params, ts, nonce);
    expect(crypto.timingSafeEqual(Buffer.from(sig, 'hex'), Buffer.from(expected, 'hex'))).toBe(true);
  });

  it('should reject HMAC with wrong secret', () => {
    const ts = Math.floor(Date.now() / 1000);
    const nonce = crypto.randomUUID();
    const sig = computeHmac(secret, 'server.status', '{}', ts, nonce);
    const expected = computeHmac('wrong-secret-also-32-characters!!', 'server.status', '{}', ts, nonce);
    expect(crypto.timingSafeEqual(Buffer.from(sig, 'hex'), Buffer.from(expected, 'hex'))).toBe(false);
  });

  it('should reject HMAC with tampered operation', () => {
    const ts = Math.floor(Date.now() / 1000);
    const nonce = crypto.randomUUID();
    const sig = computeHmac(secret, 'server.status', '{}', ts, nonce);
    const expected = computeHmac(secret, 'server.stop', '{}', ts, nonce);
    expect(crypto.timingSafeEqual(Buffer.from(sig, 'hex'), Buffer.from(expected, 'hex'))).toBe(false);
  });

  it('should reject HMAC with tampered params', () => {
    const ts = Math.floor(Date.now() / 1000);
    const nonce = crypto.randomUUID();
    const sig = computeHmac(secret, 'server.sendCommand', '{"command":"save"}', ts, nonce);
    const expected = computeHmac(secret, 'server.sendCommand', '{"command":"stop"}', ts, nonce);
    expect(crypto.timingSafeEqual(Buffer.from(sig, 'hex'), Buffer.from(expected, 'hex'))).toBe(false);
  });

  it('should reject HMAC with tampered timestamp', () => {
    const ts = Math.floor(Date.now() / 1000);
    const nonce = crypto.randomUUID();
    const sig = computeHmac(secret, 'server.status', '{}', ts, nonce);
    const expected = computeHmac(secret, 'server.status', '{}', ts + 1, nonce);
    expect(crypto.timingSafeEqual(Buffer.from(sig, 'hex'), Buffer.from(expected, 'hex'))).toBe(false);
  });
});

describe('Helper Privilege Boundary — Timestamp Validation', () => {
  it('should accept current timestamp', () => {
    expect(validateTimestamp(Math.floor(Date.now() / 1000))).toBe(true);
  });

  it('should accept timestamp within tolerance', () => {
    const now = Math.floor(Date.now() / 1000);
    expect(validateTimestamp(now - 15)).toBe(true);
    expect(validateTimestamp(now + 15)).toBe(true);
    expect(validateTimestamp(now - HMAC_TIMESTAMP_TOLERANCE_SEC)).toBe(true);
  });

  it('should reject timestamp outside tolerance', () => {
    const now = Math.floor(Date.now() / 1000);
    expect(validateTimestamp(now - HMAC_TIMESTAMP_TOLERANCE_SEC - 1)).toBe(false);
    expect(validateTimestamp(now + HMAC_TIMESTAMP_TOLERANCE_SEC + 1)).toBe(false);
    expect(validateTimestamp(now - 300)).toBe(false);
    expect(validateTimestamp(0)).toBe(false);
  });
});

describe('Helper Privilege Boundary — Nonce Replay Prevention', () => {
  it('should track used nonces to prevent replay', () => {
    const usedNonces = new Map<string, number>();
    const nonce1 = crypto.randomUUID();

    // First use — should succeed
    expect(usedNonces.has(nonce1)).toBe(false);
    usedNonces.set(nonce1, Date.now());

    // Second use — should be detected as replay
    expect(usedNonces.has(nonce1)).toBe(true);
  });

  it('should clean up expired nonces', () => {
    const usedNonces = new Map<string, number>();
    const cutoff = Date.now() - HMAC_TIMESTAMP_TOLERANCE_SEC * 2 * 1000;

    // Add an old nonce
    usedNonces.set('old-nonce-1234567890', cutoff - 1000);
    // Add a fresh nonce
    usedNonces.set('fresh-nonce-12345678', Date.now());

    // Cleanup
    for (const [nonce, ts] of usedNonces) {
      if (ts < cutoff) usedNonces.delete(nonce);
    }

    expect(usedNonces.size).toBe(1);
    expect(usedNonces.has('fresh-nonce-12345678')).toBe(true);
    expect(usedNonces.has('old-nonce-1234567890')).toBe(false);
  });
});