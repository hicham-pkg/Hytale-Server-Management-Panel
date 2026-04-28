# Security Notes — Hytale Server Management Panel

## Threat Model Summary

This panel is designed for a **single VPS, small admin team** (1–3 users) scenario, running behind a TLS-terminating reverse proxy.

### Trust Zones

| Zone | Component | Trust Level | Privileges |
|------|-----------|------------|-----------|
| Zone 0 | Browser | Untrusted | None — all input validated server-side |
| Zone 1 | Docker containers (API + DB) | Low trust | No root, no host filesystem (except Unix socket mount) |
| Zone 2 | Helper service | Medium trust | Dedicated non-root helper user with HMAC auth, allowlisted operations, and narrow sudoers for service/journal access |
| Zone 3 | Game server | Isolated | Runs as dedicated `hytale` user |

### Key Threats and Mitigations

| Threat | Mitigation |
|--------|-----------|
| **Command injection** | Character allowlist `[a-zA-Z0-9 _\-\.@:\/]` on console commands; max 200 chars; no shell metacharacters |
| **Path traversal** | `path.resolve()` + prefix check + symlink rejection in helper |
| **CSRF** | SameSite=Strict cookies + X-CSRF-Token header on all mutations |
| **Session theft** | HttpOnly/Secure/SameSite cookies; admin idle timeout 15 min; readonly idle timeout 60 min; 4h absolute lifetime |
| **Brute force** | API login rate limiting (5 attempts/15 min per IP) + nginx login rate limiting + account lockout (10 fails → 30 min) |
| **WebSocket auth bypass** | Session cookie validated on WS upgrade; explicit `WS_ALLOWED_ORIGINS`; message and connection rate limits |
| **Privilege escalation** | HMAC-signed helper requests with timestamp; non-root helper; exact allowlisted `systemctl` sudoers plus a validating `journalctl` wrapper; non-root Docker |
| **Backup restore abuse** | Server-stopped precondition; automatic safety snapshot before restore |
| **Unsafe mod uploads** | API stages raw `.jar` / `.zip` uploads outside web/static paths; helper validates staged IDs and filenames before moving files into `/opt/hytale/mods`; files are never extracted or executed by the panel |
| **XSS via logs** | ANSI stripping; React default escaping; no `dangerouslySetInnerHTML`; baseline CSP on web responses (currently allows `'unsafe-inline'` scripts for Next.js runtime compatibility) |
| **Docker escape** | Non-root container; no `--privileged`; only Unix socket mounted |
| **Replay attacks** | HMAC includes timestamp (±30s window) |
| **Log injection** | HTML-escape all log lines; render as plain text |

### What This Panel Does NOT Protect Against

- Physical access to the VPS
- Compromise of the host OS root account
- Zero-day vulnerabilities in Node.js, Docker, or PostgreSQL
- DDoS attacks (use Cloudflare or similar)
- Malicious game server plugins/mods (out of scope)
- Social engineering of admin credentials

---

## Hardening Guide

### 1. Operating System

```bash
# Keep system updated
sudo apt update && sudo apt upgrade -y

# Enable automatic security updates
sudo apt install unattended-upgrades
sudo dpkg-reconfigure -plow unattended-upgrades

# Configure firewall
sudo ufw default deny incoming
sudo ufw default allow outgoing
sudo ufw allow ssh
sudo ufw allow 80/tcp          # HTTP (redirect to HTTPS)
sudo ufw allow 443/tcp         # HTTPS (reverse proxy)
sudo ufw allow 25565/tcp       # Hytale game port (adjust as needed)
sudo ufw enable

# Disable root SSH login
sudo sed -i 's/^PermitRootLogin.*/PermitRootLogin no/' /etc/ssh/sshd_config
sudo systemctl restart sshd

# Use SSH key authentication (disable password auth)
sudo sed -i 's/^#PasswordAuthentication.*/PasswordAuthentication no/' /etc/ssh/sshd_config
sudo systemctl restart sshd
```

### 2. Docker Hardening

```bash
# Ensure Docker runs with user namespace remapping (optional, advanced)
# Edit /etc/docker/daemon.json:
{
  "userns-remap": "default",
  "no-new-privileges": true,
  "log-driver": "json-file",
  "log-opts": {
    "max-size": "10m",
    "max-file": "3"
  }
}

# Restart Docker
sudo systemctl restart docker
```

### 3. Panel Configuration

```bash
# In .env, ensure:
NODE_ENV=production
TRUST_PROXY=127.0.0.1          # Only trust your reverse proxy
CORS_ORIGIN=https://panel.yourdomain.com  # Exact origin
SESSION_MAX_AGE_HOURS=4         # Absolute session maximum
SESSION_IDLE_TIMEOUT_MINUTES=60
ADMIN_SESSION_IDLE_TIMEOUT_MINUTES=15
MAX_FAILED_LOGINS=10            # Account lockout
```

Admin accounts must enroll TOTP before they receive a fully authenticated session. The first successful password login for a new admin account returns a setup-required response instead of dashboard access.

### 4. Reverse Proxy

- **Always use TLS** — the panel sets Secure cookie flag
- **Enable HSTS** — `Strict-Transport-Security: max-age=31536000; includeSubDomains`
- **Restrict access** — Prefer Cloudflare Access, Tailscale/WireGuard, or a strict IP allowlist if your admin team has predictable source IPs
- **Expose only the web UI** — keep the API on `127.0.0.1` behind the web container/reverse proxy and never expose the helper socket outside the host
- **Set `WS_ALLOWED_ORIGINS` explicitly** — production console WebSocket access is rejected if it is left empty
- **Do not publish** PostgreSQL, the API, or the helper socket to the public internet
- See [docs/reverse-proxy.md](docs/reverse-proxy.md) for configuration examples

### 5. Filesystem Permissions

| Path | Owner | Group | Mode | Purpose |
|------|-------|-------|------|---------|
| `/opt/hytale/` | hytale | hytale | 755 | Game server root |
| `/opt/hytale/Server/` | hytale | hytale | 755 | Server data |
| `/opt/hytale/Server/whitelist.json` | hytale | hytale | 664 | Whitelist (helper writes via group) |
| `/opt/hytale/Server/bans.json` | hytale | hytale | 664 | Bans (helper writes via group) |
| `/opt/hytale-backups/` | hytale | hytale | 2770 | Backup storage (helper writes via group; setgid keeps group ownership) |
| `/opt/hytale/mods/` | hytale | hytale | 2770 | Active Hytale mods |
| `/opt/hytale/mods-disabled/` | hytale | hytale | 2770 | Disabled Hytale mods |
| `/opt/hytale/mod-backups/` | hytale | hytale | 2770 | Helper-created mod snapshots |
| `/opt/hytale-panel-data/mod-upload-staging/` | 1000 | hytale-panel | 2770 | API-only raw mod upload staging; helper reads staged files before install |
| `/opt/hytale-panel/helper/` | root | hytale-panel | 750 | Helper service code |
| `/opt/hytale-panel/helper/.env` | root | hytale-panel | 640 | Helper secrets |
| `/opt/hytale-panel/run/` | hytale-helper | hytale-panel | 770 | Stable helper socket directory |
| `/opt/hytale-panel/run/hytale-helper.sock` | hytale-helper | hytale-panel | 660 | Host helper Unix socket |

The API container stays non-root (`1000:1000`) and joins the numeric group from `.env` (`PANEL_SOCKET_GID`, default `2001`). Docker bind-mounts the stable host helper socket directory from `/opt/hytale-panel/run` into the container at `/run/hytale-helper`, so helper restarts do not require manual socket-path surgery.

### 6. Secret Rotation

Rotate these after first install, after restoring from an untrusted backup, and after any suspected credential leak:
- `SESSION_SECRET`
- `CSRF_SECRET`
- `HELPER_HMAC_SECRET`
- `DB_PASSWORD`

#### Session Secret
```bash
# Generate new secret
NEW_SECRET=$(openssl rand -hex 32)

# Update .env
sed -i "s/^SESSION_SECRET=.*/SESSION_SECRET=$NEW_SECRET/" .env

# Restart API (all existing sessions will be invalidated)
docker compose restart api
```

#### CSRF Secret
```bash
NEW_CSRF=$(openssl rand -hex 32)
sed -i "s/^CSRF_SECRET=.*/CSRF_SECRET=$NEW_CSRF/" .env
docker compose restart api
```

#### HMAC Secret (API ↔ Helper)
```bash
NEW_HMAC=$(openssl rand -hex 32)

# Update both .env files
sed -i "s/^HELPER_HMAC_SECRET=.*/HELPER_HMAC_SECRET=$NEW_HMAC/" .env
sed -i "s/^HELPER_HMAC_SECRET=.*/HELPER_HMAC_SECRET=$NEW_HMAC/" /opt/hytale-panel/helper/.env

# Restart both services
sudo systemctl restart hytale-helper.service
docker compose up -d --force-recreate api
```

#### Database Password
```bash
NEW_DB_PASS=$(openssl rand -hex 16)

# Update .env
sed -i "s/^DB_PASSWORD=.*/DB_PASSWORD=$NEW_DB_PASS/" .env
# Also update DATABASE_URL if it contains the password
sed -i "s|hytale_panel:[^@]*@|hytale_panel:$NEW_DB_PASS@|" .env

# Update PostgreSQL password
docker compose exec postgres psql -U hytale_panel -c "ALTER USER hytale_panel PASSWORD '$NEW_DB_PASS';"

# Restart services
docker compose restart
```

### 7. Monitoring and Alerting

```bash
# Monitor helper service
journalctl -u hytale-helper.service -f

# Monitor API container
docker compose logs -f api

# Monitor game server
journalctl -u hytale-tmux.service -f

# Check for failed login attempts (in audit log)
docker compose exec postgres psql -U hytale_panel -c \
  "SELECT * FROM audit_logs WHERE action='auth.login' AND success=false ORDER BY created_at DESC LIMIT 20;"
```

If you need retention beyond the VPS, forward Docker logs, helper journald logs, and exported audit logs to off-box storage. The panel does not implement remote log shipping by itself.

### 8. Backup Security

- Backups are stored at `/opt/hytale-backups/` as tar.gz archives
- Each backup has a SHA256 integrity hash stored in the database
- Backup filenames are server-generated (timestamp + UUID), never user-controlled
- `deploy/backup-database.sh` now creates database dumps with restrictive permissions (`umask 077`, directory `750`, files `640`)
- Restore operations:
  - Require admin role
  - Require server to be stopped
  - Automatically create a safety snapshot before restoring
  - Validate tar contents (no absolute paths, no traversal, no symlinks/hardlinks/devices, no files outside target)
  - Extract without restoring archive owner or mode bits
- If backups leave the VPS, encrypt them first. Off-box backup encryption is an operator task, not something the panel currently performs.

### 9. Incident Response

If you suspect a compromise:

1. **Immediately** stop the panel: `docker compose down`
2. **Rotate all secrets** (see Secret Rotation above)
3. **Check audit logs** for suspicious activity
4. **Review** `/var/log/auth.log` for SSH access
5. **Check** `docker logs hytale-panel-api` for unusual requests
6. **Verify** the shipped helper unit is still in place: `systemctl show -p User,Group,SupplementaryGroups,NoNewPrivileges hytale-helper.service`
7. **Restore** from a known-good backup if needed

---

## Responsible Disclosure

If you discover a security vulnerability, please report it privately. Do not open a public issue.
