# Upgrade Guide — Hytale Server Management Panel

How to update the panel safely with minimal downtime.

## Table of Contents

1. [Pre-Upgrade Checklist](#pre-upgrade-checklist)
2. [Standard Upgrade](#standard-upgrade)
3. [Database Migration Upgrades](#database-migration-upgrades)
4. [Helper Service Upgrades](#helper-service-upgrades)
5. [Rollback Procedure](#rollback-procedure)
6. [Breaking Change Upgrades](#breaking-change-upgrades)

---

## Pre-Upgrade Checklist

Before any upgrade:

- [ ] Read the release notes / changelog
- [ ] Back up the database: `docker compose exec postgres pg_dump -U hytale_panel > backup-pre-upgrade.sql`
- [ ] Back up `.env`: `cp .env .env.backup`
- [ ] Back up helper `.env`: `sudo cp /opt/hytale-panel/helper/.env /opt/hytale-panel/helper/.env.backup`
- [ ] Note the current version: `git log --oneline -1`
- [ ] Ensure the game server has a recent world backup
- [ ] Plan for 2–5 minutes of panel downtime (game server stays running)

---

## Standard Upgrade

For routine updates (no database migrations, no breaking changes):

```bash
cd /path/to/hytale-panel
git pull origin main
bash deploy/update-panel.sh
```

`deploy/update-panel.sh` preserves existing env files, backfills helper/runtime
defaults, reinstalls the shipped helper unit, redeploys the helper, recreates
the API container so it sees the helper socket bind cleanly, rebuilds the panel
containers, waits for helper socket + API/web readiness, runs migrations,
finishes with `scripts/repair-panel.sh`, migrates older helper envs to the
stable host socket path, and removes stale
`hytale-helper.service.d/override.conf` files from earlier manual recovery work.

**Downtime**: ~1–3 minutes depending on image rebuild time

---

## Database Migration Upgrades

If the release includes new database migrations:

```bash
cd /path/to/hytale-panel

# 1. Pull latest code
git pull origin main

# 2. Back up the database
docker compose exec postgres pg_dump -U hytale_panel > backup-pre-migration.sql

# 3. Rebuild the API container
docker compose build api

# 4. Run migrations
docker compose up -d api
docker compose exec api node dist/db/migrate.js

# 5. Verify
docker compose logs api --tail 20
```

**Downtime**: ~1–2 minutes

---

## Helper Service Upgrades

If you need the helper-only path:

```bash
cd /path/to/hytale-panel

# 1. Pull latest code
git pull origin main

# 2. Rebuild and redeploy the helper runtime
sudo ./deploy/deploy-helper.sh

# 3. Check for new root .env variables
diff .env.example .env
# Add any new variables that were introduced

# 4. Verify
sudo systemctl status hytale-helper.service
journalctl -u hytale-helper.service --no-pager -n 10
bash scripts/doctor.sh
```

**Downtime**: ~5 seconds (helper restart)

---

## Rollback Procedure

If an upgrade goes wrong:

### One-Command Rollback

If the repo checkout is git-based, the simplest rollback path is:

```bash
cd /path/to/hytale-panel
bash deploy/rollback-panel.sh <previous-commit>
```

That checks out the requested git revision and reruns the full non-dev update
flow. If the bad release changed the database schema incompatibly, restore the
database backup first or immediately after the code rollback.

### Manual Rollback API

```bash
# 1. Revert code
git checkout <previous-commit>

# 2. Rebuild and restart
docker compose build api
docker compose up -d api
```

### Manual Rollback Database

```bash
# 1. Stop API
docker compose stop api

# 2. Restore database backup
cat backup-pre-migration.sql | docker compose exec -T postgres psql -U hytale_panel

# 3. Revert code
git checkout <previous-commit>

# 4. Rebuild and restart
docker compose build api
docker compose up -d api
```

### Manual Rollback Helper

```bash
# 1. Revert code
git checkout <previous-commit>

# 2. Rebuild and redeploy
pnpm install
sudo ./deploy/deploy-helper.sh

# 3. Restart
sudo systemctl restart hytale-helper.service
```

### Manual Rollback .env

```bash
cp .env.backup .env
docker compose restart api
```

---

## Breaking Change Upgrades

For major version upgrades with breaking changes:

1. **Read the migration guide** in the release notes carefully
2. **Stop the panel** completely: `docker compose down`
3. **Back up everything**:
   ```bash
   docker compose exec postgres pg_dump -U hytale_panel > full-backup.sql
   cp .env .env.backup
   sudo cp /opt/hytale-panel/helper/.env /opt/hytale-panel/helper/.env.backup
   ```
4. **Pull the new version**: `git pull origin main`
5. **Follow the specific migration steps** from the release notes
6. **Update .env** with any new required variables
7. **Run the upgrade script**:
   ```bash
   bash deploy/update-panel.sh
   ```
8. **Verify** all services are running correctly
9. **Test** key functionality: login, dashboard, console, backups

---

## Version Checking

```bash
# Check current code version
git log --oneline -1

# Check API container version
docker compose exec api node -e "console.log(require('./package.json').version)"

# Check helper version
cat /opt/hytale-panel/helper/package.json | grep version

# Check migration files bundled in the running API image
docker compose exec api ls -1 dist/db/migrations
```
