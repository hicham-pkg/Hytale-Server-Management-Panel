# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Repository Layout

- **`hytale-panel/`** — The production monorepo (pnpm workspaces). Contains the Fastify API, Next.js web frontend, privileged helper service, shared types, seed scripts, Docker Compose, systemd units, and deployment tooling. This is the codebase the VPS install script targets.

## hytale-panel — Commands

This is a **pnpm workspaces** monorepo. `npm install` and `yarn install` break the `workspace:*` protocol — the root `preinstall` hook enforces pnpm.

```bash
# From hytale-panel/
pnpm install                                      # install all workspaces
pnpm run build                                    # build in order: shared → helper → api → web
pnpm run build:shared                             # or per package
pnpm test                                         # vitest, all tests under tests/
pnpm exec vitest run tests/api/csrf-protection.test.ts    # single test file
pnpm exec vitest run -t "rejects without token"           # single test by name

# Per-package dev servers
pnpm --filter @hytale-panel/api dev               # API with tsx watch
pnpm --filter @hytale-panel/web dev               # Next.js on :3000
pnpm --filter @hytale-panel/helper dev            # helper (won't bind socket without root perms)
pnpm --filter @hytale-panel/shared dev            # tsc --watch

# DB / secrets
pnpm --filter @hytale-panel/api migrate           # apply Drizzle migrations
pnpm --filter @hytale-panel/api seed              # seed admin user (uses ADMIN_USERNAME/ADMIN_PASSWORD env)
pnpm run generate-secret                          # mint helper HMAC secret
```

Tests **do not** live inside each package — they live at `hytale-panel/tests/{api,e2e,helper,web}/`. The root `vitest.config.ts` aliases `@hytale-panel/shared` to the TS source so tests run without a prior build.

## Ops / Deployment (hytale-panel)

Installation and updates are shell scripts, not CI:

```bash
sudo ./install.sh                    # first-time VPS install (Ubuntu)
bash deploy/update-panel.sh          # standard update path (refreshes helper + containers)
bash deploy/rollback-panel.sh <ref>  # check out git ref and redeploy
bash scripts/doctor.sh               # runtime health check
bash scripts/repair-panel.sh         # common-issue auto-repair
bash scripts/smoke-test.sh           # post-deploy smoke checks
```

`doctor.sh` and `smoke-test.sh` read `WEB_HOST_PORT` / `API_HOST_PORT` from `.env` — don't hardcode ports when adding ops checks.

## Architecture — What Requires Cross-File Context

### Four-zone privilege separation

1. **Browser** — untrusted; CSRF token required on mutations (`x-csrf-token` header); SameSite=Strict cookies.
2. **Docker containers** (`api`, `web`, `postgres`) — non-root, read-only FS, `cap_drop: ALL`, `no-new-privileges`. The API container has exactly one host bind: the helper Unix socket at `/opt/hytale-panel/run/hytale-helper.sock`.
3. **Helper service** — runs on the host (systemd unit `hytale-helper.service`), **not** in Docker. Root-ish but sandboxed. Every RPC is HMAC-signed with a ±30s timestamp window (`HMAC_TIMESTAMP_TOLERANCE_SEC` in shared/constants). Only operations in the `HELPER_OPERATIONS` allowlist are accepted.
4. **Game server** — runs as `hytale` user in a tmux session on a shared explicit socket (`/opt/hytale/run/hytale.tmux.sock`). tmux is how the helper writes to stdin for console commands.

When adding host-side functionality, it must go through the helper — the API container has no other route to the host. Add the operation to `HELPER_OPERATIONS` in `packages/shared/src/constants.ts`, implement the handler in `packages/helper/src/handlers/`, and call it from the API via `callHelper()` in `packages/api/src/services/helper-client.ts`.

### Request flow (mutation)

Browser → nginx (TLS) → Docker web (3000) or API (4000) → `callHelper()` over Unix socket → helper executes allowlisted systemctl/tmux/fs op → result flows back. Every step has validation; skipping any layer breaks the security model.

### Whitelist has online/offline modes

See `hytale-panel/README.md` §"Whitelist Behavior". The file stores UUIDs, not names. Online (server running) uses console commands for add/remove; offline allows only UUID removal via direct file edit. `/api/whitelist/remove-offline` takes `{uuid}`, while `/api/whitelist/remove` takes `{name}` — not interchangeable.

### Config is Zod-validated at startup

`packages/api/src/config.ts` parses env vars via Zod on first `getConfig()` call. Missing or malformed env vars cause the process to crash immediately rather than fail later. Minimum-length checks on `sessionSecret`, `csrfSecret`, and `helperHmacSecret` are enforced here (32 chars).

### Admin TOTP is mandatory

Password-only admin sessions are rejected — the login flow stops at TOTP enrollment for admins that haven't enrolled yet. Readonly users can optionally enroll. Admin idle timeout is 15 min vs 60 min for readonly (`DEFAULT_ADMIN_SESSION_IDLE_TIMEOUT_MINUTES` in shared/constants).

### Input validation constants

`packages/shared/src/constants.ts` owns the allowlist regexes (`COMMAND_CHAR_ALLOWLIST`, `PLAYER_NAME_REGEX`, `BACKUP_LABEL_REGEX`, `UUID_REGEX`) and limits (`MAX_COMMAND_LENGTH`, `MAX_LOG_LINES`, WebSocket rate limits). When touching validation, update shared — both the API and helper import from the same module, so they stay in sync.

### Settings are mostly env-driven

The settings UI only exposes TOTP/2FA setup and user management. Session lifetimes, rate limits, retention, and host paths (`HYTALE_ROOT`, `WHITELIST_PATH`, etc.) are configured via `.env` (API) and the helper's separate `.env` at `/opt/hytale-panel/helper/.env`. Don't add runtime toggles for security-critical values.

## Key Docs

- `hytale-panel/SECURITY.md` — threat model, hardening steps
- `hytale-panel/docs/architecture.md` — full architecture rationale
- `hytale-panel/docs/operations.md` — day-to-day ops
- `hytale-panel/docs/reverse-proxy.md` — nginx/Caddy/Cloudflare Tunnel configs
- `hytale-panel/docs/upgrade.md` — schema/version upgrade procedure
