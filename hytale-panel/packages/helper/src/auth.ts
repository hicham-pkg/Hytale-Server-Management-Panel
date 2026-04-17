import * as crypto from 'crypto';
import { HMAC_TIMESTAMP_TOLERANCE_SEC } from '@hytale-panel/shared';
import type { HelperConfig } from './config';

const HMAC_HEX_LENGTH = 64; // SHA-256 produces 32 bytes = 64 hex chars

const usedNonces = new Map<string, number>();

/** Clean up expired nonces every 60 seconds */
setInterval(() => {
  const cutoff = Date.now() - HMAC_TIMESTAMP_TOLERANCE_SEC * 2 * 1000;
  for (const [nonce, ts] of usedNonces) {
    if (ts < cutoff) usedNonces.delete(nonce);
  }
}, 60_000);

export function computeHmac(
  secret: string,
  operation: string,
  params: string,
  timestamp: number,
  nonce: string
): string {
  const payload = `${timestamp}:${nonce}:${operation}:${params}`;
  return crypto.createHmac('sha256', secret).update(payload).digest('hex');
}

export function validateRequest(
  config: HelperConfig,
  operation: string,
  params: Record<string, unknown>,
  timestamp: number,
  nonce: string,
  signature: string
): { valid: boolean; error?: string } {
  const now = Math.floor(Date.now() / 1000);
  const drift = Math.abs(now - timestamp);
  if (drift > HMAC_TIMESTAMP_TOLERANCE_SEC) {
    return { valid: false, error: `Timestamp drift too large: ${drift}s` };
  }

  if (usedNonces.has(nonce)) {
    return { valid: false, error: 'Nonce already used (replay attack)' };
  }

  // Validate signature length before timingSafeEqual to avoid throwing
  if (!signature || signature.length !== HMAC_HEX_LENGTH) {
    return { valid: false, error: 'Invalid signature format' };
  }

  const paramsStr = JSON.stringify(params);
  const expected = computeHmac(config.hmacSecret, operation, paramsStr, timestamp, nonce);

  const sigBuf = Buffer.from(signature, 'hex');
  const expectedBuf = Buffer.from(expected, 'hex');

  // Guard: both should be 32 bytes, but check defensively
  if (sigBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(sigBuf, expectedBuf)) {
    return { valid: false, error: 'Invalid HMAC signature' };
  }

  usedNonces.set(nonce, Date.now());
  return { valid: true };
}