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

- Default localhost binds:
  - Web: `127.0.0.1:3000`
  - API: `127.0.0.1:4000`
  - PostgreSQL: `127.0.0.1:5432`
- Main host services:
  - `hytale-helper.service`
  - `hytale-tmux.service`
- Standard operator commands:

```bash
cd hytale-panel
bash deploy/update-panel.sh
bash deploy/rollback-panel.sh <git-ref>
bash scripts/doctor.sh
bash scripts/repair-panel.sh
```

For reverse proxy setup and ops details, see:

- `docs/reverse-proxy.md`
- `docs/operations.md`
- `SECURITY.md`

## Troubleshooting (Common)

- **Installer succeeds but panel actions fail**
  - Check `sudo systemctl status hytale-helper.service`
  - Check `cd hytale-panel && docker compose ps`
  - Run `cd hytale-panel && bash scripts/doctor.sh`

- **Console WebSocket blocked in production**
  - Set `CORS_ORIGIN` and `WS_ALLOWED_ORIGINS` in `hytale-panel/.env`

- **Need first admin user after install**
  - Run `cd hytale-panel && pnpm --filter @hytale-panel/api seed`
