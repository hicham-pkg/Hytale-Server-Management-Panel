#!/bin/bash
# ============================================================
# Hytale Panel — Database Backup Script
# ============================================================
# Creates a compressed PostgreSQL backup.
# Can be run manually or via cron.
#
# Usage:
#   ./deploy/backup-database.sh                    # Backup to default location
#   ./deploy/backup-database.sh /path/to/backups   # Backup to custom location
#
# Cron example (daily at 3 AM):
#   0 3 * * * /path/to/hytale-panel/deploy/backup-database.sh >> /var/log/hytale-panel-db-backup.log 2>&1
# ============================================================

set -euo pipefail
umask 077

BACKUP_DIR="${1:-/opt/hytale-panel/db-backups}"
TIMESTAMP=$(date +%Y%m%d-%H%M%S)
FILENAME="hytale-panel-db-${TIMESTAMP}.sql.gz"
RETENTION_DAYS=30

# Create backup directory
mkdir -p "$BACKUP_DIR"
chmod 750 "$BACKUP_DIR"

echo "[$(date)] Starting database backup..."

# Create compressed backup
docker compose exec -T postgres pg_dump -U hytale_panel | gzip > "${BACKUP_DIR}/${FILENAME}"
chmod 640 "${BACKUP_DIR}/${FILENAME}"

if [ $? -eq 0 ]; then
  SIZE=$(du -h "${BACKUP_DIR}/${FILENAME}" | cut -f1)
  echo "[$(date)] Backup created: ${FILENAME} (${SIZE})"
else
  echo "[$(date)] ERROR: Backup failed!"
  exit 1
fi

# Clean up old backups
DELETED=$(find "$BACKUP_DIR" -name "hytale-panel-db-*.sql.gz" -mtime +${RETENTION_DAYS} -delete -print | wc -l)
if [ "$DELETED" -gt 0 ]; then
  echo "[$(date)] Cleaned up ${DELETED} backup(s) older than ${RETENTION_DAYS} days"
fi

echo "[$(date)] Database backup complete."
