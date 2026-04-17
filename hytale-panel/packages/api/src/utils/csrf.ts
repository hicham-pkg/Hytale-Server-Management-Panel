import * as crypto from 'crypto';

export const CSRF_TOKEN_HEX_LENGTH = 64;

export function generateCsrfToken(secret: string, sessionId: string): string {
  return crypto.createHmac('sha256', secret).update(sessionId).digest('hex');
}
