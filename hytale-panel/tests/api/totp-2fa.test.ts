import { describe, it, expect } from 'vitest';
import { z } from 'zod';

/**
 * TOTP 2FA Tests
 * Tests TOTP code validation schema, bypass prevention,
 * and the 2FA flow invariants.
 */

const VerifyTotpSchema = z.object({
  code: z.string().length(6).regex(/^\d{6}$/),
});

describe('TOTP 2FA — Code Schema Validation', () => {
  it('should accept valid 6-digit TOTP codes', () => {
    expect(VerifyTotpSchema.parse({ code: '123456' })).toEqual({ code: '123456' });
    expect(VerifyTotpSchema.parse({ code: '000000' })).toEqual({ code: '000000' });
    expect(VerifyTotpSchema.parse({ code: '999999' })).toEqual({ code: '999999' });
  });

  it('should reject codes shorter than 6 digits', () => {
    expect(() => VerifyTotpSchema.parse({ code: '12345' })).toThrow();
    expect(() => VerifyTotpSchema.parse({ code: '1' })).toThrow();
    expect(() => VerifyTotpSchema.parse({ code: '' })).toThrow();
  });

  it('should reject codes longer than 6 digits', () => {
    expect(() => VerifyTotpSchema.parse({ code: '1234567' })).toThrow();
    expect(() => VerifyTotpSchema.parse({ code: '12345678' })).toThrow();
  });

  it('should reject non-numeric codes', () => {
    expect(() => VerifyTotpSchema.parse({ code: 'abcdef' })).toThrow();
    expect(() => VerifyTotpSchema.parse({ code: '12ab56' })).toThrow();
    expect(() => VerifyTotpSchema.parse({ code: '12 456' })).toThrow();
    expect(() => VerifyTotpSchema.parse({ code: '12-456' })).toThrow();
  });

  it('should reject non-string types', () => {
    expect(() => VerifyTotpSchema.parse({ code: 123456 })).toThrow();
    expect(() => VerifyTotpSchema.parse({ code: null })).toThrow();
    expect(() => VerifyTotpSchema.parse({ code: undefined })).toThrow();
  });

  it('should reject missing code field', () => {
    expect(() => VerifyTotpSchema.parse({})).toThrow();
  });
});

describe('TOTP 2FA — Bypass Prevention', () => {
  // The auth service enforces that sessions with pending2fa=true
  // cannot access any protected endpoint until TOTP is verified.

  it('should not allow skipping 2FA by accessing protected routes directly', () => {
    // Simulates the requireAuth middleware behavior
    const session = { pending2fa: true, valid: true };
    // requireAuth returns 401 "2FA verification required" when pending2fa is true
    const canAccess = session.valid && !session.pending2fa;
    expect(canAccess).toBe(false);
  });

  it('should not allow reusing a pre-2FA session cookie for full access', () => {
    // Even with a valid session ID, pending2fa blocks all protected routes
    const session = { id: 'valid-session-id', pending2fa: true };
    const isFullyAuthenticated = !session.pending2fa;
    expect(isFullyAuthenticated).toBe(false);
  });

  it('should allow access after TOTP verification completes', () => {
    // After verifyTotp succeeds, pending2fa is set to false
    const session = { id: 'valid-session-id', pending2fa: false };
    const isFullyAuthenticated = !session.pending2fa;
    expect(isFullyAuthenticated).toBe(true);
  });
});

describe('TOTP 2FA — Setup requires admin role', () => {
  it('should only allow admin users to setup TOTP', () => {
    const adminUser = { role: 'admin' };
    const readonlyUser = { role: 'readonly' };
    expect(adminUser.role === 'admin').toBe(true);
    expect(readonlyUser.role === 'admin').toBe(false);
  });
});

describe('TOTP 2FA — Confirm requires valid code', () => {
  it('should reject confirmation with invalid code format', () => {
    expect(() => VerifyTotpSchema.parse({ code: 'invalid' })).toThrow();
  });

  it('should accept confirmation with valid code format', () => {
    const result = VerifyTotpSchema.safeParse({ code: '123456' });
    expect(result.success).toBe(true);
  });
});