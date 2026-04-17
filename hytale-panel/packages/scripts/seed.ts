/**
 * Seed script — creates the initial admin user.
 *
 * Usage:
 *   cd packages/scripts
 *   npx tsx seed.ts
 *
 * Environment:
 *   DATABASE_URL — PostgreSQL connection string
 *   ADMIN_USERNAME — (optional) defaults to "admin"
 *   ADMIN_PASSWORD — (optional) defaults to a generated random password
 *
 * This script is idempotent: if the admin user already exists, it skips creation.
 */

import * as crypto from 'crypto';

async function main() {
  // Dynamic imports to avoid requiring these as direct dependencies
  const argon2 = await import('argon2');
  const { drizzle } = await import('drizzle-orm/node-postgres');
  const { Pool } = await import('pg');
  const { eq } = await import('drizzle-orm');

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error('ERROR: DATABASE_URL environment variable is required.');
    console.error('Example: DATABASE_URL=postgresql://hytale_panel:password@127.0.0.1:5432/hytale_panel');
    process.exit(1);
  }

  const username = process.env.ADMIN_USERNAME || 'admin';
  const password = process.env.ADMIN_PASSWORD || crypto.randomBytes(16).toString('hex');
  const wasGenerated = !process.env.ADMIN_PASSWORD;

  const pool = new Pool({ connectionString: databaseUrl });

  try {
    // Check if users table exists
    const tableCheck = await pool.query(
      `SELECT EXISTS (SELECT FROM information_schema.tables WHERE table_name = 'users')`
    );
    if (!tableCheck.rows[0].exists) {
      console.error('ERROR: Database tables not found. Run migrations first:');
      console.error('  docker compose exec api node dist/db/migrate.js');
      process.exit(1);
    }

    // Check if admin user already exists
    const existing = await pool.query('SELECT id FROM users WHERE username = $1', [username]);
    if (existing.rows.length > 0) {
      console.log(`User "${username}" already exists (id: ${existing.rows[0].id}). Skipping.`);
      process.exit(0);
    }

    // Hash password with Argon2id
    const passwordHash = await argon2.hash(password, {
      type: argon2.argon2id,
      memoryCost: 65536,
      timeCost: 3,
      parallelism: 4,
    });

    const id = crypto.randomUUID();

    await pool.query(
      `INSERT INTO users (id, username, password_hash, role, totp_enabled, failed_login_attempts)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [id, username, passwordHash, 'admin', false, 0]
    );

    console.log('');
    console.log('╔══════════════════════════════════════════════╗');
    console.log('║     Admin user created successfully!         ║');
    console.log('╠══════════════════════════════════════════════╣');
    console.log(`║  Username: ${username.padEnd(34)}║`);
    if (wasGenerated) {
      console.log(`║  Password: ${password.padEnd(34)}║`);
      console.log('║                                              ║');
      console.log('║  ⚠  SAVE THIS PASSWORD — it won\'t be shown  ║');
      console.log('║     again. Change it after first login.      ║');
    } else {
      console.log('║  Password: (as provided via ADMIN_PASSWORD)  ║');
    }
    console.log('╚══════════════════════════════════════════════╝');
    console.log('');
  } catch (err) {
    console.error('Seed failed:', err);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

main();
