/**
 * Generate cryptographic secrets for the .env file.
 *
 * Usage:
 *   npx tsx generate-helper-secret.ts
 *
 * Outputs ready-to-paste .env lines for:
 *   - SESSION_SECRET
 *   - CSRF_SECRET
 *   - HELPER_HMAC_SECRET
 *   - DB_PASSWORD
 */

import * as crypto from 'crypto';

function generateSecret(bytes: number = 32): string {
  return crypto.randomBytes(bytes).toString('hex');
}

console.log('# Generated secrets — paste into your .env file');
console.log(`SESSION_SECRET=${generateSecret(32)}`);
console.log(`CSRF_SECRET=${generateSecret(32)}`);
console.log(`HELPER_HMAC_SECRET=${generateSecret(32)}`);
console.log(`DB_PASSWORD=${generateSecret(16)}`);