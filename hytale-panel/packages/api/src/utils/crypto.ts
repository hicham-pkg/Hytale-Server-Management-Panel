import * as crypto from 'crypto';
import * as argon2 from 'argon2';

/**
 * Hash a password with Argon2id.
 */
export async function hashPassword(password: string): Promise<string> {
  return argon2.hash(password, {
    type: argon2.argon2id,
    memoryCost: 65536,
    timeCost: 3,
    parallelism: 4,
  });
}

/**
 * Verify a password against an Argon2 hash.
 */
export async function verifyPassword(hash: string, password: string): Promise<boolean> {
  return argon2.verify(hash, password);
}

/**
 * Generate a cryptographically secure random token.
 */
export function generateToken(bytes: number = 32): string {
  return crypto.randomBytes(bytes).toString('hex');
}

/**
 * Generate a UUID v4.
 */
export function generateUuid(): string {
  return crypto.randomUUID();
}

/**
 * Compute HMAC-SHA256 for helper service communication.
 */
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