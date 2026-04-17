# Hytale Server Management Panel

A production-grade, security-focused web panel for managing a personal Hytale game server on Ubuntu.

## Architecture Overview

```
                    ┌─────────────────────────────────────────────────────┐
                    │                    VPS (Ubuntu)                      │
                    │                                                     │
  Browser ──HTTPS──▶│  Nginx (TLS)                                       │
                    │    ├── /           → web:3000  (Next.js frontend)   │
                    │    ├── /api/*      → api:4000  (Fastify API)        │
                    │    └── /ws/*       → api:4000  (WebSocket)          │
                    │                                                     │
                    │  ┌─── Docker ────────────────────────────┐          │
                    │  │  web       (Next.js, port 3000)       │          │
                    │  │  api       (Fastify, port 4000)  ─────┼──┐      │
                    │  │  postgres  (PostgreSQL 16)             │  │      │
                    │  └───────────────────────────────────────┘  │      │
                    │                                              │      │
                    │  Unix Socket (/opt/hytale-panel/run/*.sock) ◀──┘   │
                    │       │                                             │
                    │  Helper Service (Node.js, host, systemd)           │
                    │       │                                             │
                    │       ├── systemctl start/stop/restart              │
                    │       ├── tmux send-keys (console commands)         │
                    │       ├── journalctl (log reading)                  │
                    │       ├── tar (backup/restore)                      │
                    │       └── file I/O (whitelist, bans)               │
                    │                                                     │
                    │  Hytale Game Server (tmux session, systemd)         │
                    └─────────────────────────────────────────────────────┘
```

### Component Summary

| Component | Technology | Runs In | Port |
|-----------|-----------|---------|------|
| **Web Frontend** | Next.js + React + Tailwind + shadcn/ui | Docker | 3000 (127.0.0.1) |
| **API Server** | Fastify + TypeScript + Drizzle ORM | Docker | 4000 (127.0.0.1) |
| **Database** | PostgreSQL 16 | Docker | 5432 (Docker network + 127.0.0.1 only) |
| **Helper Service** | Node.js + Fastify on Unix socket | Host (systemd) | Unix socket |
| **Game Server** | Hytale in tmux | Host (systemd) | 25565 (public) |
| **Reverse Proxy** | Nginx / Caddy / Cloudflare Tunnel | Host | 443 (public) |

### Security Model — 4-Zone Privilege Separation

| Zone | Component | Privileges |
|------|-----------|-----------| 
| Zone 0 | Browser | None — all actions require authenticated API calls |
| Zone 1 | Docker containers | Network access to DB and helper socket only |
| Zone 2 | Helper service | Local-only root helper with systemd sandbox, HMAC auth, and allowlisted operations only |
| Zone 3 | Game server | Runs as `hytale` user, isolated |

See [SECURITY.md](SECURITY.md) for the full threat model and hardening guide.

## Prerequisites

- **Ubuntu 22.04+** with systemd
- **Docker Engine 24+** and Docker Compose v2
- **Node.js 20 LTS** (for helper service on host)
- **pnpm 9+** (this project uses pnpm workspaces — npm/yarn are not supported)
- **tmux** (for game server console access)
- **A reverse proxy** with TLS (nginx, Caddy, or Cloudflare Tunnel)
- **Hytale game server** installed at `/opt/hytale/`

## Quick Start

### 1. Clone and Install

```bash
git clone https://github.com/your-repo/hytale-panel.git
cd hytale-panel
sudo ./install.sh
```

The install script will:
- Install system dependencies (tmux, Docker, Node.js, pnpm)
- Create the `hytale` user and the dedicated `hytale-panel` socket group
- Set up directories with correct permissions
- Install the correct systemd units for the helper and tmux launcher
- Generate cryptographic secrets in `.env`
- Build and deploy the helper service
- Disable any legacy `hytale.service` unit automatically
- Build and start the PostgreSQL/API/web stack
- Run database migrations
- Optionally create the first admin user if you pass `ADMIN_USERNAME` and `ADMIN_PASSWORD`, or prompt interactively on a terminal

### 2. Configure Ports and Origins

If you want non-default host ports or already know your browser origins, either:
- let `install.sh` prompt you for them interactively on the first run, or
- pre-create `.env` from `.env.example` before you run `sudo ./install.sh`.

You can still edit `.env` later, but after changing host ports or origin values
you should rerun:

```bash
bash deploy/update-panel.sh
```

Typical values:

```bash
nano .env
# Optional: avoid host port conflicts without editing docker-compose.yml
# WEB_HOST_PORT=43000
# API_HOST_PORT=44000
# POSTGRES_HOST_PORT=15432

# For first private testing over SSH tunnel, set these to your local browser origin:
# CORS_ORIGIN=http://localhost:43000
# WS_ALLOWED_ORIGINS=http://localhost:43000

# After you have a real HTTPS hostname, switch them to:
# CORS_ORIGIN=https://panel.yourdomain.com
# WS_ALLOWED_ORIGINS=https://panel.yourdomain.com
```

In production, `WS_ALLOWED_ORIGINS` is mandatory for the live console. If it
is left empty, the console WebSocket is rejected on purpose instead of failing
open.

See [.env.example](.env.example) for all available configuration options.

The web container always proxies internally to `http://api:4000` on the Docker network. Changing `WEB_HOST_PORT` or your SSH tunnel port does not change the internal service-to-service routing.

The shipped session defaults are intentionally short:
- Admin sessions idle out after `15` minutes
- Read-only sessions idle out after `60` minutes
- All sessions have a `4` hour absolute maximum lifetime

### 3. Verify the Shipped Services

`install.sh` now enables the helper, builds the containers, starts the stack,
and runs migrations automatically. Verify the shipped services:

```bash
sudo systemctl status hytale-helper.service
docker compose ps
```

The shipped tmux wrapper uses a shared explicit socket so the helper and the
`hytale-tmux.service` unit see the same server runtime:

```bash
sudo -u hytale tmux -S /opt/hytale/run/hytale.tmux.sock has-session -t hytale
sudo -u hytale tmux -S /opt/hytale/run/hytale.tmux.sock attach -t hytale
```

### 4. Create the Admin User If You Skipped It During Install

```bash
# Option A: Use the seed script (recommended)
DB_PASSWORD="$(grep '^DB_PASSWORD=' .env | cut -d= -f2-)"
POSTGRES_HOST_PORT="${POSTGRES_HOST_PORT:-5432}"
DATABASE_URL="postgresql://hytale_panel:${DB_PASSWORD}@127.0.0.1:${POSTGRES_HOST_PORT}/hytale_panel" \
  pnpm --filter @hytale-panel/api seed

# Option B: Specify credentials
DB_PASSWORD="$(grep '^DB_PASSWORD=' .env | cut -d= -f2-)"
POSTGRES_HOST_PORT="${POSTGRES_HOST_PORT:-5432}"
DATABASE_URL="postgresql://hytale_panel:${DB_PASSWORD}@127.0.0.1:${POSTGRES_HOST_PORT}/hytale_panel" \
  ADMIN_USERNAME=admin \
  ADMIN_PASSWORD=your-secure-password \
  pnpm --filter @hytale-panel/api seed
```

The Compose stack publishes PostgreSQL on `127.0.0.1:${POSTGRES_HOST_PORT:-5432}` only, so the seed script works from the VPS without exposing the database publicly. The seed script is idempotent — running it again when the user exists is safe.

### 5. Access It Privately First Over SSH Tunnel

Before exposing the panel publicly, test the login flow over an SSH tunnel:

```bash
# Forward the VPS web bind to a local browser port
WEB_HOST_PORT="${WEB_HOST_PORT:-3000}"
ssh -L 43000:127.0.0.1:${WEB_HOST_PORT} your-user@your-vps
```

Then open `http://localhost:43000` in your browser.

Recommended first-run order:
1. Password login with the seeded admin account
2. TOTP enrollment for that admin account
3. Dashboard load
4. Helper-backed actions after login succeeds

If the dashboard shows the server as offline while Hytale is already running,
check the shared tmux socket above first. The helper and the systemd unit must
both be using `/opt/hytale/run/hytale.tmux.sock`, not tmux's default socket
under `/tmp`.

### 6. Set Up the Reverse Proxy

See [docs/reverse-proxy.md](docs/reverse-proxy.md) for nginx, Caddy, and Cloudflare Tunnel configurations.

The nginx config routes:
- `/` → Web frontend (port 3000)
- `/api/*` → API server (port 4000)
- `/ws/*` → WebSocket (port 4000)

```bash
sudo cp nginx/hytale-panel.conf /etc/nginx/sites-available/hytale-panel
sudo ln -s /etc/nginx/sites-available/hytale-panel /etc/nginx/sites-enabled/
# Edit the file to replace panel.yourdomain.com with your domain
sudo nginx -t && sudo systemctl reload nginx
sudo certbot --nginx -d panel.yourdomain.com
```

### 7. Prepare the Hytale Server

Ensure your Hytale server is installed at `/opt/hytale/` with a launch script:

```bash
cat > /opt/hytale/start.sh << 'EOF'
#!/bin/bash
cd /opt/hytale
java -Xmx4G -Xms2G -jar /opt/hytale/HytaleServer.jar
EOF
chmod +x /opt/hytale/start.sh
```

The shipped `hytale-tmux.service` now sets `TMPDIR=/opt/hytale/tmp` and
`JAVA_TOOL_OPTIONS=-Djava.io.tmpdir=/opt/hytale/tmp` automatically so native
libraries can extract safely under the hardened systemd unit. You do not need
to hardcode a temp directory inside `start.sh`.

### 8. Move On to Real Hytale Actions

After the panel login works cleanly, test the actual Hytale-backed actions:
- server status / start / stop
- whitelist operations
- live console
- backups

On the first successful admin password login, the panel will stop at TOTP enrollment and require you to scan a QR code before the session becomes fully authenticated. Password-only admin sessions are not allowed.

### 9. Normal Operator Workflow

For routine health checks and recovery, use the bundled scripts instead of
remembering long manual command sequences:

```bash
# Quick runtime health check
bash scripts/doctor.sh

# One-command safe repair for the common real VPS issues
bash scripts/repair-panel.sh

# Standard one-command update path
bash deploy/update-panel.sh

# Roll back to a previous git checkout and redeploy it
bash deploy/rollback-panel.sh HEAD~1
```

`doctor.sh` and `smoke-test.sh` automatically read `WEB_HOST_PORT` and
`API_HOST_PORT` from `.env`, so they follow the same localhost binds you
actually configured on the VPS.

`deploy/update-panel.sh` now handles the non-dev upgrade path end to end:
- refreshes installed helper/systemd files without wiping envs
- migrates older helper installs from `/run/hytale-helper/...` to the stable host socket at `/opt/hytale-panel/run/hytale-helper.sock`
- retires stale `hytale-helper.service.d/override.conf` drop-ins from older manual fixes
- redeploys the helper
- recreates the API container so the helper socket bind is guaranteed current
- rebuilds the panel containers
- waits for the stable host helper socket, the container-visible helper socket bind, and API/web health before moving on
- runs migrations
- runs repair + smoke checks

`deploy/rollback-panel.sh <git-ref>` checks out the requested git revision and
then runs the same update flow. If the rolled-back release needs an older
database schema, restore your pre-upgrade database backup as described in
[docs/upgrade.md](docs/upgrade.md).

## First-Run Hardening

Before you expose the panel publicly, work through [docs/hardening-checklist.md](docs/hardening-checklist.md).

The short version:
- Keep PostgreSQL, the API, and the helper socket private to the VPS
- Put the panel behind Cloudflare Access, a VPN/private network, or a strict IP allowlist if practical
- Rotate the generated secrets after first install and again after any suspected compromise
- Finish TOTP enrollment for every admin account before handing out access
- Encrypt backups before copying them off the VPS
- Ship audit/helper logs off-box if you need retention beyond the single server

## Dependency Management

This project uses **pnpm workspaces**. Do not use `npm install` or `yarn install` — they do not support the `workspace:*` protocol used here.

```bash
# Install all dependencies
pnpm install

# Build all packages in order
pnpm run build

# Run tests
pnpm test

# Build individual packages
pnpm --filter @hytale-panel/shared build
pnpm --filter @hytale-panel/helper build
pnpm --filter @hytale-panel/api build
pnpm --filter @hytale-panel/web build
```

## Build Order

The monorepo has build dependencies:

```
shared → helper → api → web
```

Always build in this order. `pnpm run build` handles this automatically.

## Project Structure

```
hytale-panel/
├── packages/
│   ├── shared/          # Shared types, schemas, constants
│   ├── api/             # Fastify API server (Docker)
│   ├── helper/          # Privileged helper service (host)
│   ├── web/             # Next.js frontend (Docker)
│   └── scripts/         # Seed and utility scripts
├── nginx/               # Nginx reverse proxy config
├── systemd/             # systemd unit files
├── tests/               # Test suites
├── docs/                # Documentation
│   ├── architecture.md
│   ├── operations.md
│   └── reverse-proxy.md
├── docker-compose.yml
├── install.sh
├── .env.example
├── pnpm-workspace.yaml
├── SECURITY.md
└── README.md
```

## Features

- **Dashboard** — Server status, system stats, quick actions
- **Live Console** — Real-time game server console via WebSocket
- **Player Management** — Whitelist and ban list editing
- **Backup & Restore** — Create, download, and restore world backups
- **Crash Detection** — Automatic log scanning for crash patterns
- **Audit Logging** — Full audit trail of all admin actions
- **User Management** — Multi-user with admin/readonly roles
- **2FA (TOTP)** — Required for admin accounts; optional for readonly accounts
- **Dark Theme** — Modern dark admin interface

## Whitelist Behavior

The Hytale whitelist file (`whitelist.json`) stores UUIDs, not player names:

```json
{"enabled": true, "list": ["550e8400-e29b-41d4-a716-446655440000"]}
```

### Online (server running)

- **Add player**: Enter a player name → the panel sends `whitelist add <name>` via console command. The Hytale server resolves the name to a UUID internally and adds it to the file.
- **Remove player**: Enter a player name → the panel sends `whitelist remove <name>` via console command. The server resolves the name internally.
- **Toggle whitelist**: Sends `whitelist on` / `whitelist off` via console command.
- UUID entries in the file are displayed as-is. The panel does **not** resolve UUIDs to usernames.

### Offline (server stopped)

- **Remove UUID**: You can remove a specific UUID entry directly from the whitelist file via the trash icon next to each UUID.
- **Toggle whitelist**: The `enabled` flag can be toggled via file editing. The UUID list is preserved untouched.
- **Add player**: Not supported offline. Name-to-UUID resolution requires the running Hytale server.

### Limitations

- UUID-to-username resolution is **not implemented**. The panel displays raw UUIDs from the file.
- Online add/remove operations depend on the Hytale server's own whitelist command support.
- Offline file edits (UUID removal, toggle) are only allowed when the server is stopped to avoid conflicts.

### API Contracts

| Endpoint | Payload | When |
|----------|---------|------|
| `POST /api/whitelist/add` | `{ "name": "PlayerName" }` | Server running |
| `POST /api/whitelist/remove` | `{ "name": "PlayerName" }` | Server running |
| `POST /api/whitelist/remove-offline` | `{ "uuid": "550e8400-..." }` | Server stopped |
| `POST /api/whitelist/toggle` | `{ "enabled": true }` | Any time |

## Settings

Panel settings are managed via environment variables and the `.env` file. The current settings UI is intentionally narrow:

- **TOTP / 2FA setup**
- **User management**

Session lifetime, rate limits, audit/crash retention, and server paths stay environment-driven. Server paths (`HYTALE_ROOT`, `WHITELIST_PATH`, etc.) are configured exclusively via the helper service's `.env` file and are not editable through the web UI for security reasons.

## Documentation

- [SECURITY.md](SECURITY.md) — Threat model, hardening guide
- [docs/architecture.md](docs/architecture.md) — Detailed architecture
- [docs/operations.md](docs/operations.md) — Day-to-day operations guide
- [docs/reverse-proxy.md](docs/reverse-proxy.md) — Nginx, Caddy, Cloudflare Tunnel setup
- [docs/hardening-checklist.md](docs/hardening-checklist.md) — First-run security checklist

## License

MIT
