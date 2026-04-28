# Operations Guide — Hytale Server Management Panel

Day-to-day operations, monitoring, log management, and maintenance procedures.

## Table of Contents

1. [Service Management](#service-management)
2. [Monitoring](#monitoring)
3. [Log Management](#log-management)
4. [Database Maintenance](#database-maintenance)
5. [Backup Management](#backup-management)
6. [Mods Management](#mods-management)
7. [User Management](#user-management)
8. [Scheduled Tasks](#scheduled-tasks)
9. [Whitelist Management](#whitelist-management)
10. [Troubleshooting](#troubleshooting)

---

## Service Management

### First-Run Order

1. `sudo ./install.sh`
2. Verify `hytale-helper.service` is active
3. Verify `docker compose ps` shows healthy `postgres`, `api`, and `web`
4. Seed the first admin user only if you skipped it during install
5. Open an SSH tunnel to the web bind
6. Complete the first admin login and TOTP enrollment

Do not expect helper-backed panel actions to work until `hytale-helper.service` is active and the socket exists.

### Starting All Services

```bash
# 1. Start or refresh the helper first if you changed host-side helper files
sudo systemctl restart hytale-helper.service

# 2. Start the panel stack
cd /path/to/hytale-panel
docker compose up -d

# 3. Start the game server
sudo systemctl start hytale-tmux.service
```

### Host Port Overrides

If `3000`, `4000`, or `5432` are already in use on the VPS host, set these in `.env` instead of editing Compose directly:

```bash
WEB_HOST_PORT=43000
API_HOST_PORT=44000
POSTGRES_HOST_PORT=15432
```

The internal Docker routing still uses `web:3000`, `api:4000`, and `postgres:5432`.

### Private First-Run Access

For the first login, it is usually simpler to keep the panel private and use an SSH tunnel:

```bash
WEB_HOST_PORT="${WEB_HOST_PORT:-3000}"
ssh -L 43000:127.0.0.1:${WEB_HOST_PORT} your-user@your-vps
```

Then browse to `http://localhost:43000`.

If you want WebSocket-origin checks to succeed during this private test, set:

```bash
CORS_ORIGIN=http://localhost:43000
WS_ALLOWED_ORIGINS=http://localhost:43000
```

### Stopping All Services

```bash
# 1. Stop the panel
docker compose down

# 2. Stop the helper
sudo systemctl stop hytale-helper.service

# 3. Stop the game server (sends save command first)
sudo systemctl stop hytale-tmux.service
```

### Checking Status

```bash
# Game server
sudo systemctl status hytale-tmux.service

# Helper service
sudo systemctl status hytale-helper.service

# Panel containers
docker compose ps

# All at once
echo "=== Game Server ===" && sudo systemctl is-active hytale-tmux.service
echo "=== Helper ===" && sudo systemctl is-active hytale-helper.service
echo "=== API ===" && docker compose ps api --format "{{.Status}}"
echo "=== Database ===" && docker compose ps postgres --format "{{.Status}}"
```

### Restarting Individual Services

```bash
# Restart API only (e.g., after config change)
docker compose restart api

# Restart helper (e.g., after secret rotation)
# The stable host socket path keeps the API bind mount valid, but the shipped
# helper deploy/update scripts also recreate the API container automatically.
sudo systemctl restart hytale-helper.service

# Restart game server (sends save first via ExecStop)
sudo systemctl restart hytale-tmux.service
```

### Session and Account Security

- Admin sessions use a `15` minute idle timeout.
- Read-only sessions use a `60` minute idle timeout.
- All sessions expire absolutely after `4` hours even if they stay active.
- Admin accounts must finish TOTP enrollment before the panel grants full access.
- Any password or role change invalidates all active sessions for that account.

---

## Monitoring

### Real-time Log Monitoring

```bash
# API logs
docker compose logs -f api

# Helper service logs
journalctl -u hytale-helper.service -f

# Game server logs
journalctl -u hytale-tmux.service -f

# All panel logs combined
docker compose logs -f & journalctl -u hytale-helper.service -f
```

### Resource Usage

```bash
# Docker container resource usage
docker stats hytale-panel-api hytale-panel-db

# System resources
htop
# or
free -h && df -h && uptime
```

### Health Checks

```bash
# API health (from the host)
API_HOST_PORT="${API_HOST_PORT:-4000}"
curl -s "http://127.0.0.1:${API_HOST_PORT}/api/health" | jq .

# Web proxy -> API health (from the host)
WEB_HOST_PORT="${WEB_HOST_PORT:-3000}"
curl -s "http://127.0.0.1:${WEB_HOST_PORT}/api/health" | jq .

# Database connectivity
docker compose exec postgres pg_isready -U hytale_panel

# Host helper socket exists and is accessible
ls -la /opt/hytale-panel/run/hytale-helper.sock

# Check the shared socket group used by Docker + helper
getent group hytale-panel

# Game server tmux socket + session exist
test -S /opt/hytale/run/hytale.tmux.sock && echo "tmux socket present"
sudo -u hytale tmux -S /opt/hytale/run/hytale.tmux.sock has-session -t hytale 2>/dev/null && echo "Running" || echo "Not running"
```

Or run the bundled smoke test:

```bash
bash scripts/smoke-test.sh
```

For a more operator-friendly runtime check:

```bash
# Report helper/API/tmux/systemd state
bash scripts/doctor.sh

# Attempt safe repairs for common stale states, helper unit drift, legacy
# service confusion, and API/helper socket wiring, then re-check
bash scripts/repair-panel.sh
```

Both scripts read `WEB_HOST_PORT` and `API_HOST_PORT` from the repo `.env`, so
they check the same localhost binds the panel is actually using. The helper
socket health checks now distinguish between the host path
`/opt/hytale-panel/run/hytale-helper.sock` and the container-visible bind mount
`/run/hytale-helper/hytale-helper.sock`.

The Mods Manager uses a narrow API write mount at
`/opt/hytale-panel-data/mod-upload-staging`. The API stages raw `.jar` / `.zip`
uploads there only; the host helper validates the staged ID and moves files into
`/opt/hytale/mods`.

The shipped `hytale-tmux.service` also provides a dedicated writable temp
directory at `/opt/hytale/tmp` and exports it through `TMPDIR` and
`JAVA_TOOL_OPTIONS=-Djava.io.tmpdir=/opt/hytale/tmp`. That avoids native
library extraction failures under `ProtectSystem=strict`.

## Operator Commands

```bash
# Fresh install / first bring-up
sudo ./install.sh

# Routine update
bash deploy/update-panel.sh

# Safe repair for common stale states
bash scripts/repair-panel.sh

# Roll back to a previous git revision and redeploy it
bash deploy/rollback-panel.sh <git-ref>
```

The repair flow also migrates older helper installs to the stable host socket
path, removes stale `hytale-helper.service.d/override.conf` files, recreates
the API container if the helper socket bind drifted, and retires legacy
`hytale.service` automatically.

---

## Log Management

### Log Locations

| Component | Log Location | Retention |
|-----------|-------------|-----------|
| API | Docker logs (`docker compose logs api`) | Docker log rotation |
| PostgreSQL | Docker logs (`docker compose logs postgres`) | Docker log rotation |
| Helper | journalctl (`-u hytale-helper.service`) | systemd journal rotation |
| Game Server | journalctl (`-u hytale-tmux.service`) | systemd journal rotation |
| Audit Logs | PostgreSQL `audit_logs` table | Configurable (default: 90 days) |
| Crash Events | PostgreSQL `crash_events` table | Configurable (default: 30 days) |

For incident response or compliance retention, forward the helper journal, Docker logs, and audit-log exports to off-box storage. This repo does not ship a built-in remote log sink.

### Docker Log Rotation

Add to `/etc/docker/daemon.json`:

```json
{
  "log-driver": "json-file",
  "log-opts": {
    "max-size": "10m",
    "max-file": "3"
  }
}
```

Then restart Docker: `sudo systemctl restart docker`

### Systemd Journal Rotation

Edit `/etc/systemd/journald.conf`:

```ini
[Journal]
SystemMaxUse=500M
MaxRetentionSec=30day
```

Then restart: `sudo systemctl restart systemd-journald`

### Audit Log Cleanup

The API automatically cleans up old audit logs based on `AUDIT_LOG_RETENTION_DAYS`. To manually clean:

```bash
docker compose exec postgres psql -U hytale_panel -c \
  "DELETE FROM audit_logs WHERE created_at < NOW() - INTERVAL '90 days';"
```

### Exporting Audit Logs

```bash
# Via the panel UI: Audit Log → Export button

# Via API (requires admin session cookie):
curl -b "hytale_session=<session-id>" \
  http://127.0.0.1:4000/api/audit-logs/export > audit-export.json

# Direct database export:
docker compose exec postgres pg_dump -U hytale_panel -t audit_logs --data-only > audit-logs.sql
```

---

## Database Maintenance

### Running Migrations

```bash
docker compose exec api node dist/db/migrate.js
```

### Database Backup

```bash
# Full database dump
docker compose exec postgres pg_dump -U hytale_panel > hytale-panel-db-$(date +%Y%m%d).sql

# Compressed
docker compose exec postgres pg_dump -U hytale_panel | gzip > hytale-panel-db-$(date +%Y%m%d).sql.gz
```

### Database Restore

```bash
# Stop the API first
docker compose stop api

# Restore
cat hytale-panel-db-backup.sql | docker compose exec -T postgres psql -U hytale_panel

# Restart API
docker compose start api
```

### Vacuum and Analyze

```bash
docker compose exec postgres psql -U hytale_panel -c "VACUUM ANALYZE;"
```

---

## Backup Management

### Storage Expectations

- Backups are stored at `/opt/hytale-backups/`
- Each backup is a tar.gz of the worlds directory
- Typical size: 100MB–10GB depending on world size
- Plan for at least 5× your world size for backup storage

### Manual Backup (outside the panel)

```bash
sudo -u hytale tar -czf /opt/hytale-backups/manual-$(date +%Y%m%d-%H%M%S).tar.gz \
  -C /opt/hytale/Server worlds/
```

### Monitoring Backup Disk Usage

```bash
du -sh /opt/hytale-backups/
ls -lhS /opt/hytale-backups/
```

### Cleaning Old Backups

The panel does not auto-delete backups. Periodically review and delete old ones via the panel UI or:

```bash
# List backups older than 30 days
find /opt/hytale-backups/ -name "*.tar.gz" -mtime +30 -ls

# Delete (be careful!)
find /opt/hytale-backups/ -name "*.tar.gz" -mtime +30 -delete
```

---

## Mods Management

### Storage Expectations

- Active mods: `/opt/hytale/mods`
- Disabled mods: `/opt/hytale/mods-disabled`
- Raw upload staging: `/opt/hytale-panel-data/mod-upload-staging`
- Mod snapshots: `/opt/hytale/mod-backups`

Upload mods from the panel's Mods page. The API only writes staged files; the
host helper performs install, enable, disable, backup, rollback, and restart
verification actions.

### Manual Checks

```bash
sudo ls -lah /opt/hytale/mods /opt/hytale/mods-disabled
sudo ls -lah /opt/hytale/mod-backups | tail
sudo ls -lah /opt/hytale-panel-data/mod-upload-staging
```

---

## User Management

### Creating Users via CLI

```bash
docker compose exec api node -e "
  const { hashPassword } = require('./dist/utils/crypto.js');
  const { getDb, schema } = require('./dist/db/index.js');
  (async () => {
    const db = getDb();
    const hash = await hashPassword('secure-password');
    await db.insert(schema.users).values({
      username: 'newadmin',
      passwordHash: hash,
      role: 'admin',
    });
    console.log('User created');
    process.exit(0);
  })();
"
```

### Resetting a Password via CLI

```bash
docker compose exec postgres psql -U hytale_panel -c \
  "UPDATE users SET password_hash = '<new-argon2-hash>', failed_login_attempts = 0, locked_until = NULL WHERE username = 'admin';"
```

To generate an Argon2 hash:

```bash
docker compose exec api node -e "
  const { hashPassword } = require('./dist/utils/crypto.js');
  hashPassword('new-password').then(h => { console.log(h); process.exit(0); });
"
```

### Unlocking a Locked Account

```bash
docker compose exec postgres psql -U hytale_panel -c \
  "UPDATE users SET failed_login_attempts = 0, locked_until = NULL WHERE username = 'admin';"
```

---

## Scheduled Tasks

The API runs these background jobs automatically:

| Job | Interval | Purpose |
|-----|----------|---------|
| Crash detector | Every 5 minutes | Scans journalctl for crash patterns |
| Session cleanup | Every 15 minutes | Removes expired sessions |

These run in-process via `node-cron` — no external cron configuration needed.
Crash detection is best-effort: the scan cursor is persisted in the database, but each scan still reads a bounded log window, so very high-volume bursts can still evade detection between scan intervals.

Automatic backup scheduling and retention pruning are not implemented in the shipped panel yet. Backups are manual, and retention cleanup must be handled by the operator.

---

## Whitelist Management

### How the Whitelist Works

The Hytale whitelist file (`/opt/hytale/Server/whitelist.json`) stores UUIDs:

```json
{"enabled": true, "list": ["550e8400-e29b-41d4-a716-446655440000"]}
```

The panel provides two modes of operation:

**Online (server running)**:
- Add/remove players by **username** via console commands
- The Hytale server resolves names to UUIDs internally
- Toggle whitelist on/off via console command

**Offline (server stopped)**:
- Remove **UUID** entries directly from the file
- Toggle the `enabled` flag via file edit (preserves the UUID list)
- Adding players by name is **not supported** offline (no name→UUID resolution)

### Limitations

- The panel does **not** resolve UUIDs to player names. The whitelist page shows raw UUIDs.
- Online operations depend on the Hytale server's whitelist command support.
- Offline file edits are blocked while the server is running to prevent conflicts.

---

## Troubleshooting

### API Won't Start

```bash
# Check logs
docker compose logs api --tail 50

# Common issues:
# - DATABASE_URL wrong → check .env
# - Helper socket missing → start hytale-helper.service first
# - Port 4000 in use → check with: ss -tlnp | grep 4000
```

### Helper Service Won't Start

```bash
# Check logs
journalctl -u hytale-helper.service --no-pager -n 50

# Common issues:
# - .env missing → check /opt/hytale-panel/helper/.env
# - Permission denied → check ownership of /opt/hytale-panel/helper/
# - Node.js not found → install Node.js 20
```

### Can't Connect to Game Server Console

```bash
# Check if tmux session exists
sudo -u hytale tmux -S /opt/hytale/run/hytale.tmux.sock list-sessions

# Check if game server is running
sudo systemctl status hytale-tmux.service

# Manually attach to console (for debugging)
sudo -u hytale tmux -S /opt/hytale/run/hytale.tmux.sock attach -t hytale
# Detach with Ctrl+B, then D
```

### Panel Stop Then Start Does Not Recover the Server

```bash
# Preferred operator path
bash scripts/doctor.sh --repair

# Then retry Start from the panel
```

`doctor.sh --repair` safely clears common stale states:
- stale `hytale-tmux.service` state with no live tmux runtime
- stale tmux session with no Hytale Java process
- API container socket visibility drift after helper restarts

### WebSocket Connection Fails

```bash
# Check if API is running
curl -s http://127.0.0.1:4000/api/health

# Check reverse proxy WebSocket support
# nginx: ensure proxy_set_header Upgrade and Connection are set
# Caddy: WebSocket proxying is automatic

# Check CORS/origin settings in .env
grep WS_ALLOWED_ORIGINS .env
```

### Database Connection Issues

```bash
# Check if PostgreSQL is running
docker compose ps postgres

# Test connection
docker compose exec postgres psql -U hytale_panel -c "SELECT 1;"

# Check disk space (PostgreSQL needs space for WAL)
df -h
```
