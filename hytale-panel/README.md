# Hytale Server Management Panel

A self-hosted web panel for managing a Hytale server on Ubuntu. It provides server control, live console access, player management, backups, crash/event tracking, and audit logs through a security-focused split between a containerized API/web stack and a host helper service.

## Key Features

- Server lifecycle control (`start`, `stop`, `restart`, status)
- Live console over WebSocket with command support
- Whitelist and ban management
- Backup create/restore with job tracking
- Crash/event history and audit logs
- Multi-user auth with `admin` and `readonly` roles
- TOTP/2FA support (required for admin accounts)

## Requirements

- Ubuntu 22.04+
- Hytale server files on the host (default: `/opt/hytale`)
- `systemd`, `tmux`, Docker Engine + Compose
- Reverse proxy for public HTTPS access (nginx/Caddy/Cloudflare Tunnel)

## Installation

```bash
git clone https://github.com/hicham-pkg/Hytale-Server-Management-Panel.git
cd Hytale-Server-Management-Panel
sudo ./install.sh
```

The installer sets up dependencies, helper + systemd units, Docker services, migrations, and health checks.

Optional flags and environment:

- `sudo ./install.sh -y` (or `--yes` / `--non-interactive`) — skip prompts for CI / scripted use.
- `ADMIN_USERNAME=... ADMIN_PASSWORD=... sudo ./install.sh` — seed the first admin non-interactively.
- Host port overrides (set in `.env` before install, or edit later and re-run `deploy/update-panel.sh`): `WEB_HOST_PORT`, `API_HOST_PORT`, `POSTGRES_HOST_PORT`.
- Reverse-proxy origins: `CORS_ORIGIN` and `WS_ALLOWED_ORIGINS` must be set in production; the console WebSocket is rejected otherwise.

On the first successful admin login, the panel requires TOTP enrollment before the session becomes fully authenticated — admin accounts cannot be used with password only.

## Development / Local Workflow

All workspace code lives in `hytale-panel/`:

```bash
cd hytale-panel
pnpm install
pnpm run build
pnpm test
```

Run package dev servers:

```bash
pnpm --filter @hytale-panel/api dev
pnpm --filter @hytale-panel/web dev
pnpm --filter @hytale-panel/helper dev
```

Useful package scripts:

```bash
pnpm --filter @hytale-panel/api migrate
pnpm --filter @hytale-panel/api seed
pnpm run generate-secret
```

## Production Notes

- Default localhost binds (override in `.env` via `WEB_HOST_PORT`, `API_HOST_PORT`, `POSTGRES_HOST_PORT`):
  - Web: `127.0.0.1:3000`
  - API: `127.0.0.1:4000`
  - PostgreSQL: `127.0.0.1:5432`
- Main host services:
  - `hytale-helper.service`
  - `hytale-tmux.service`
- Session defaults (override via `.env`): admin idle timeout 15 min, readonly idle timeout 60 min, absolute session lifetime 4 h.
- Admin guardrails: the last remaining admin cannot be demoted or deleted through the users API.
- Standard operator commands:

```bash
cd hytale-panel
bash deploy/update-panel.sh
bash deploy/rollback-panel.sh <git-ref>
bash scripts/doctor.sh
bash scripts/repair-panel.sh
```

## Documentation

- [`SECURITY.md`](SECURITY.md) — threat model, hardening posture
- [`docs/architecture.md`](docs/architecture.md) — full architecture and the 4-zone privilege model
- [`docs/operations.md`](docs/operations.md) — day-to-day operations, backups, logs
- [`docs/reverse-proxy.md`](docs/reverse-proxy.md) — nginx / Caddy / Cloudflare Tunnel setup
- [`docs/hardening-checklist.md`](docs/hardening-checklist.md) — first-run security checklist
- [`docs/recovery.md`](docs/recovery.md) — disaster recovery
- [`docs/upgrade.md`](docs/upgrade.md) — version upgrade procedure

## Troubleshooting (Common)

- **Installer succeeds but panel actions fail**
  - Check `sudo systemctl status hytale-helper.service`
  - Check `cd hytale-panel && docker compose ps`
  - Run `cd hytale-panel && bash scripts/doctor.sh`

- **Console WebSocket blocked in production**
  - Set `CORS_ORIGIN` and `WS_ALLOWED_ORIGINS` in `hytale-panel/.env`

- **Need first admin user after install**
  - From `hytale-panel/`:
    ```bash
    DB_PASSWORD="$(grep '^DB_PASSWORD=' .env | cut -d= -f2-)"
    POSTGRES_HOST_PORT="${POSTGRES_HOST_PORT:-5432}"
    DATABASE_URL="postgresql://hytale_panel:${DB_PASSWORD}@127.0.0.1:${POSTGRES_HOST_PORT}/hytale_panel" \
      ADMIN_USERNAME=admin ADMIN_PASSWORD='your-secure-password' \
      pnpm --filter @hytale-panel/api seed
    ```
  - The seed script is idempotent — re-running it when the user already exists is a no-op.
