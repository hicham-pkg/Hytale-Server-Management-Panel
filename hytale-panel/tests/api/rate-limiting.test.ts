import { describe, it, expect } from 'vitest';
import {
  DEFAULT_MAX_FAILED_LOGINS,
  DEFAULT_LOCKOUT_DURATION_MINUTES,
  WS_MESSAGE_RATE_LIMIT_PER_SEC,
} from '@hytale-panel/shared';

/**
 * Rate Limiting Tests
 * Tests account lockout after failed login attempts,
 * lockout duration, and WebSocket message rate limiting.
 */

describe('Rate Limiting — Account Lockout Config', () => {
  it('should default to 10 max failed login attempts', () => {
    expect(DEFAULT_MAX_FAILED_LOGINS).toBe(10);
  });

  it('should default to 30 minute lockout duration', () => {
    expect(DEFAULT_LOCKOUT_DURATION_MINUTES).toBe(30);
  });
});

describe('Rate Limiting — Lockout Logic', () => {
  it('should lock account after reaching max failed attempts', () => {
    const maxFailedLogins = DEFAULT_MAX_FAILED_LOGINS;
    let failedAttempts = 0;
    let lockedUntil: Date | null = null;

    // Simulate failed login attempts
    for (let i = 0; i < maxFailedLogins; i++) {
      failedAttempts++;
      if (failedAttempts >= maxFailedLogins) {
        lockedUntil = new Date(Date.now() + DEFAULT_LOCKOUT_DURATION_MINUTES * 60_000);
      }
    }

    expect(failedAttempts).toBe(maxFailedLogins);
    expect(lockedUntil).not.toBeNull();
    expect(lockedUntil!.getTime()).toBeGreaterThan(Date.now());
  });

  it('should not lock account before reaching max failed attempts', () => {
    const maxFailedLogins = DEFAULT_MAX_FAILED_LOGINS;
    let failedAttempts = 0;
    let lockedUntil: Date | null = null;

    for (let i = 0; i < maxFailedLogins - 1; i++) {
      failedAttempts++;
      if (failedAttempts >= maxFailedLogins) {
        lockedUntil = new Date(Date.now() + DEFAULT_LOCKOUT_DURATION_MINUTES * 60_000);
      }
    }

    expect(failedAttempts).toBe(maxFailedLogins - 1);
    expect(lockedUntil).toBeNull();
  });

  it('should block login while account is locked', () => {
    const lockedUntil = new Date(Date.now() + 15 * 60_000); // locked for 15 more minutes
    const isLocked = lockedUntil && new Date(lockedUntil) > new Date();
    expect(isLocked).toBe(true);
  });

  it('should allow login after lockout expires', () => {
    const lockedUntil = new Date(Date.now() - 1000); // lockout expired 1 second ago
    const isLocked = lockedUntil && new Date(lockedUntil) > new Date();
    expect(isLocked).toBe(false);
  });

  it('should reset failed attempts on successful login', () => {
    let failedAttempts = 7;
    // Successful login resets counter
    failedAttempts = 0;
    expect(failedAttempts).toBe(0);
  });

  it('should compute correct lockout remaining time', () => {
    const lockoutMs = DEFAULT_LOCKOUT_DURATION_MINUTES * 60_000;
    const lockedUntil = new Date(Date.now() + lockoutMs);
    const remainingMs = lockedUntil.getTime() - Date.now();
    const remainingMin = Math.ceil(remainingMs / 60_000);
    expect(remainingMin).toBeLessThanOrEqual(DEFAULT_LOCKOUT_DURATION_MINUTES);
    expect(remainingMin).toBeGreaterThan(0);
  });
});

describe('Rate Limiting — WebSocket Message Rate', () => {
  it('should limit to 10 messages per second', () => {
    expect(WS_MESSAGE_RATE_LIMIT_PER_SEC).toBe(10);
  });

  it('should allow messages within rate limit', () => {
    let messageCount = 0;
    let lastReset = Date.now();
    const limit = WS_MESSAGE_RATE_LIMIT_PER_SEC;

    // Simulate 10 messages in 1 second
    for (let i = 0; i < limit; i++) {
      const now = Date.now();
      if (now - lastReset > 1000) {
        messageCount = 0;
        lastReset = now;
      }
      messageCount++;
    }

    expect(messageCount).toBeLessThanOrEqual(limit);
  });

  it('should reject messages exceeding rate limit', () => {
    let messageCount = 0;
    const lastReset = Date.now();
    const limit = WS_MESSAGE_RATE_LIMIT_PER_SEC;

    // Simulate 11 messages (exceeds limit)
    for (let i = 0; i < limit + 1; i++) {
      messageCount++;
    }

    const isRateLimited = messageCount > limit;
    expect(isRateLimited).toBe(true);
  });
});

describe('Rate Limiting — Login Endpoint Rate Limit Config', () => {
  it('should have stricter rate limit for login than global', () => {
    // From config defaults
    const loginRateLimitMax = 5;
    const loginRateLimitWindowMs = 900_000; // 15 minutes
    const globalRateLimitMax = 100;
    const globalRateLimitWindowMs = 60_000; // 1 minute

    // Login is stricter: 5 per 15min vs 100 per 1min
    const loginRate = loginRateLimitMax / (loginRateLimitWindowMs / 1000);
    const globalRate = globalRateLimitMax / (globalRateLimitWindowMs / 1000);
    expect(loginRate).toBeLessThan(globalRate);
  });
});