# Recovery Guide — Hytale Server Management Panel

How to recover from broken files, database issues, and disaster scenarios.

## Table of Contents

1. [Broken Whitelist File](#broken-whitelist-file)
2. [Broken Ban File](#broken-ban-file)
3. [Corrupted Backup Files](#corrupted-backup-files)
4. [Database Issues](#database-issues)
5. [Lost Admin Access](#lost-admin-access)
6. [Helper Service Failure](#helper-service-failure)
7. [Docker Volume Loss](#docker-volume-loss)
8. [Full Disaster Recovery](#full-disaster-recovery)

---

## Broken Whitelist File

**Symptoms**: Whitelist page shows error; game server ignores whitelist.

The Hytale whitelist file uses this format:
```json
{"enabled": true, "list": ["550e8400-e29b-41d4-a716-446655440000"]}
```

The `list` array contains **UUIDs**, not player names. The panel cannot resolve
UUIDs to usernames — that mapping is only available inside the running Hytale server.

**Recovery**:

```bash
# 1. Check the file
cat /opt/hytale/Server/whitelist.json

# 2. If corrupted, create a valid empty whitelist (Hytale object format)
echo '{"enabled": false, "list": []}' | sudo -u hytale tee /opt/hytale/Server/whitelist.json

# 3. Verify JSON is valid
python3 -c "import json; json.load(open('/opt/hytale/Server/whitelist.json'))" && echo "Valid JSON"

# 4. If server is running, reload via console
sudo -u hytale tmux -S /opt/hytale/run/hytale.tmux.sock send-keys -t hytale "whitelist reload" Enter
```

> **Note**: Do not manually add player names to the list — the file stores UUIDs only.
> To add players, start the server and use `whitelist add <PlayerName>` via the console
> or the panel's Add Player form. The server resolves names to UUIDs internally.

---

## Broken Ban File

**Symptoms**: Ban page shows error; bans not enforced.

**Recovery**:

```bash
# 1. Check the file
cat /opt/hytale/Server/bans.json

# 2. If corrupted or missing, create empty
echo '[]' | sudo -u hytale tee /opt/hytale/Server/bans.json

# 3. Verify
python3 -c "import json; json.load(open('/opt/hytale/Server/bans.json'))" && echo "Valid JSON"
```

---

## Corrupted Backup Files

**Symptoms**: Backup restore fails; tar reports errors.

**Diagnosis**:

```bash
# List all backups
ls -lh /opt/hytale-backups/

# Test a backup's integrity
tar -tzf /opt/hytale-backups/<filename>.tar.gz > /dev/null 2>&1 && echo "OK" || echo "CORRUPTED"

# Check SHA256 against database
sha256sum /opt/hytale-backups/<filename>.tar.gz
# Compare with value in: SELECT sha256 FROM backup_metadata WHERE filename = '<filename>';
```

**Recovery**:

```bash
# 1. If backup is corrupted, remove from database
docker compose exec postgres psql -U hytale_panel -c \
  "DELETE FROM backup_metadata WHERE filename = '<filename>';"

# 2. Remove the corrupted file
rm /opt/hytale-backups/<filename>.tar.gz

# 3. Create a fresh backup via the panel or CLI
sudo -u hytale tar -czf /opt/hytale-backups/recovery-$(date +%Y%m%d).tar.gz \
  -C /opt/hytale/Server worlds/
```

---

## Database Issues

### PostgreSQL Won't Start

```bash
# Check logs
docker compose logs postgres --tail 50

# Common fixes:
# 1. Disk full
df -h
# Clean up: docker system prune -f

# 2. Corrupted data directory
# WARNING: This destroys all data
docker compose down
docker volume rm hytale-panel_pgdata
docker compose up -d
# Then re-run migrations and re-seed
docker compose exec api node dist/db/migrate.js
```

### Migration Fails

```bash
# Check which migration SQL files are bundled in the running API image
docker compose exec api ls -1 dist/db/migrations

# If stuck, you may need to manually fix
# Check the specific migration SQL for errors
cat packages/api/src/db/migrations/0001_initial.sql

# Force re-run (if safe to do so)
docker compose exec api node dist/db/migrate.js
```

### Data Corruption

```bash
# 1. Stop the API
docker compose stop api

# 2. Check for corruption
docker compose exec postgres psql -U hytale_panel -c "
  SELECT schemaname, tablename
  FROM pg_tables
  WHERE schemaname = 'public';
"

# 3. Run integrity checks
docker compose exec postgres psql -U hytale_panel -c "
  SELECT count(*) FROM users;
  SELECT count(*) FROM sessions;
  SELECT count(*) FROM audit_logs;
  SELECT count(*) FROM backup_metadata;
  SELECT count(*) FROM crash_events;
"

# 4. If you have a database backup, restore it
docker compose stop api
cat hytale-panel-db-backup.sql | docker compose exec -T postgres psql -U hytale_panel
docker compose start api
```

---

## Lost Admin Access

### Forgot Password

```bash
# Generate a new Argon2 hash
NEW_HASH=$(docker compose exec api node -e "
  const { hashPassword } = require('./dist/utils/crypto.js');
  hashPassword('new-secure-password').then(h => { console.log(h); process.exit(0); });
" 2>/dev/null | tail -1)

# Update the password and unlock the account
docker compose exec postgres psql -U hytale_panel -c "
  UPDATE users
  SET password_hash = '$NEW_HASH',
      failed_login_attempts = 0,
      locked_until = NULL
  WHERE username = 'admin';
"

echo "Password reset. Log in with: admin / new-secure-password"
```

### Account Locked Out

```bash
docker compose exec postgres psql -U hytale_panel -c "
  UPDATE users SET failed_login_attempts = 0, locked_until = NULL WHERE username = 'admin';
"
```

### All Admin Accounts Deleted

```bash
# Create a new admin directly in the database
NEW_HASH=$(docker compose exec api node -e "
  const { hashPassword } = require('./dist/utils/crypto.js');
  hashPassword('emergency-password').then(h => { console.log(h); process.exit(0); });
" 2>/dev/null | tail -1)

docker compose exec postgres psql -U hytale_panel -c "
  INSERT INTO users (username, password_hash, role)
  VALUES ('emergency-admin', '$NEW_HASH', 'admin');
"
```

### TOTP Locked Out

```bash
# Disable TOTP for the user
docker compose exec postgres psql -U hytale_panel -c "
  UPDATE users SET totp_enabled = false, totp_secret = NULL WHERE username = 'admin';
"
```

---

## Helper Service Failure

**Symptoms**: Panel shows "Helper service unavailable"; server controls don't work.

```bash
# 1. Check status
sudo systemctl status hytale-helper.service

# 2. Check logs
journalctl -u hytale-helper.service --no-pager -n 50

# 3. Check socket exists
ls -la /opt/hytale-panel/run/hytale-helper.sock

# 4. Verify helper .env
cat /opt/hytale-panel/helper/.env

# 5. Verify helper code exists
ls -la /opt/hytale-panel/helper/dist/

# 6. Try restarting
sudo systemctl restart hytale-helper.service

# 7. If code is missing, rebuild from source
cd /path/to/hytale-panel
pnpm install
sudo ./deploy/deploy-helper.sh
```

---

## Docker Volume Loss

If the PostgreSQL data volume is lost:

```bash
# 1. Recreate the database
docker compose up -d postgres
# Wait for healthy
docker compose exec postgres pg_isready -U hytale_panel

# 2. Run migrations
docker compose exec api node dist/db/migrate.js

# 3. Create admin user (see Lost Admin Access section)

# 4. Re-import backup metadata (if backup files still exist)
# You'll need to manually re-register each backup:
for f in /opt/hytale-backups/*.tar.gz; do
  SIZE=$(stat -c%s "$f")
  SHA=$(sha256sum "$f" | cut -d' ' -f1)
  FNAME=$(basename "$f")
  docker compose exec postgres psql -U hytale_panel -c "
    INSERT INTO backup_metadata (filename, size_bytes, sha256, created_at)
    VALUES ('$FNAME', $SIZE, '$SHA', NOW());
  "
done
```

---

## Full Disaster Recovery

If the entire VPS needs to be rebuilt:

### What You Need

1. **Hytale game server files** (or a backup of `/opt/hytale/`)
2. **Panel source code** (git clone)
3. **Database backup** (if you had one)
4. **World backups** from `/opt/hytale-backups/`
5. **`.env` file** (or the secrets from it)

### Recovery Steps

```bash
# 1. Set up a new Ubuntu VPS
# 2. Clone the panel
git clone https://github.com/your-repo/hytale-panel.git
cd hytale-panel

# 3. Run the installer (installs pnpm, Node.js, Docker, etc.)
sudo ./install.sh

# 4. Restore .env (or reconfigure)
cp /path/to/backup/.env .env
# Or edit the generated .env with your domain settings

# 5. Restore game server files
sudo -u hytale cp -r /path/to/backup/hytale/* /opt/hytale/

# 6. Restore world backups
sudo cp /path/to/backup/backups/*.tar.gz /opt/hytale-backups/
sudo chown hytale:hytale /opt/hytale-backups/*.tar.gz

# 7. Start services
sudo systemctl enable --now hytale-tmux.service
sudo systemctl enable --now hytale-helper.service
docker compose up -d

# 8. Run migrations
docker compose exec api node dist/db/migrate.js

# 9. Restore database (if you have a backup)
cat db-backup.sql | docker compose exec -T postgres psql -U hytale_panel

# 10. Or create a new admin
# (see Lost Admin Access section)

# 11. Set up reverse proxy
# (see docs/reverse-proxy.md)
```

### What's Lost Without Database Backup

- User accounts (must recreate)
- Audit log history
- Crash event history
- Backup metadata (files still exist but aren't tracked)
- Settings (must reconfigure)
- Session data (users must re-login)
