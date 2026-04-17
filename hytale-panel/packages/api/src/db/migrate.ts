import * as fs from 'fs';
import * as path from 'path';
import { Pool } from 'pg';

// Application-specific advisory lock key to serialize concurrent migration
// runs. Value is arbitrary but must be stable across deploys.
const MIGRATION_LOCK_KEY = 0x4854504e; // 'HTPN' as ASCII bytes

async function migrate() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error('DATABASE_URL is required');
    process.exit(1);
  }

  const pool = new Pool({ connectionString: databaseUrl });
  const client = await pool.connect();
  let lockAcquired = false;

  try {
    // Serialize against concurrent runners (install.sh + update-panel.sh racing, etc.).
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_KEY]);
    lockAcquired = true;

    // Bootstrap the tracking table. Itself idempotent.
    await client.query(`
      CREATE TABLE IF NOT EXISTS _migrations (
        filename VARCHAR(255) PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    const { rows } = await client.query<{ filename: string }>(
      'SELECT filename FROM _migrations'
    );
    const applied = new Set(rows.map((r) => r.filename));

    const migrationDir = path.join(__dirname, 'migrations');
    const files = fs
      .readdirSync(migrationDir)
      .filter((f) => f.endsWith('.sql'))
      .sort();

    let ran = 0;
    for (const file of files) {
      if (applied.has(file)) {
        console.log(`  ↷ ${file} already applied, skipping`);
        continue;
      }

      console.log(`Running migration: ${file}`);
      const rawSql = fs.readFileSync(path.join(migrationDir, file), 'utf-8');

      // Existing files wrap themselves in BEGIN;/COMMIT;. Strip those so the
      // runner can bundle the migration body AND the tracking insert into one
      // atomic transaction. Future migrations should omit transaction control.
      const sql = rawSql
        .split('\n')
        .filter((line) => {
          const t = line.trim();
          return t !== 'BEGIN;' && t !== 'COMMIT;';
        })
        .join('\n');

      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query(
          'INSERT INTO _migrations (filename) VALUES ($1)',
          [file]
        );
        await client.query('COMMIT');
        console.log(`  ✓ ${file} applied`);
        ran += 1;
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
      }
    }

    if (ran === 0) {
      console.log('No new migrations to apply');
    } else {
      console.log(`Applied ${ran} migration(s) successfully`);
    }
  } catch (err) {
    console.error('Migration failed:', err);
    process.exitCode = 1;
  } finally {
    if (lockAcquired) {
      await client
        .query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_KEY])
        .catch(() => {});
    }
    client.release();
    await pool.end();
  }
}

migrate();
