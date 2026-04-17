# Hytale Server Management Panel — System Design

## 1. Implementation Approach

### Critical Requirements & Solutions

| Requirement | Difficulty | Solution |
|------------|-----------|---------|
| Live console command sending | High | systemd + tmux wrapper; `tmux send-keys` for input, `tmux capture-pane` for output |
| Privilege separation | High | Local-only root helper service on a Unix socket with HMAC-signed requests and a systemd sandbox |
| Backup/restore safety | Medium | Server-stopped precondition enforced by helper; automatic safety snapshot before restore |
| WebSocket security | Medium | Session cookie validation on WS upgrade; Origin header check; message rate limiting |
| Path traversal prevention | Medium | `path.resolve()` + prefix check + symlink rejection in helper service |
| Crash detection | Medium | Periodic journalctl parsing with regex pattern matching; human-readable summaries |

### Technology Stack

| Layer | Technology |
|-------|-----------|
| Frontend | Next.js 14 (App Router) + React 18 + TypeScript + Tailwind CSS + shadcn/ui |
| Backend API | Fastify 4 + TypeScript |
| Database | PostgreSQL 16 |
| ORM | Drizzle ORM |
| Realtime | @fastify/websocket |
| Auth | Argon2 (argon2 npm) + TOTP (otpauth npm) |
| Validation | Zod |
| Helper | Node.js + Fastify (Unix socket only) |
| Container | Docker Compose (panel services only) |
| Scheduler | node-cron (in-process) |

### Key Architectural Decisions

1. **systemd + tmux** for game server management (enables stdin/stdout access)
2. **Local-only helper service** with a stable host socket path and allowlisted operations
3. **Docker Compose** for panel services; game server stays on host
4. **Monorepo** with shared types package for end-to-end type safety
5. **HMAC-signed requests** between API and helper (defense in depth)

## 2. User & UI Interaction Behaviors

1. **Login** — Username + password form → required TOTP enrollment for admins (or TOTP verification if already enabled) → redirect to dashboard
2. **Dashboard overview** — At-a-glance server status, uptime, CPU/RAM/disk, recent warnings
3. **Server control** — Start/Stop/Restart buttons with confirmation modals; result shown as toast + audit entry
4. **Live console** — Scrolling log output; command input with history; admin-only command sending
5. **Whitelist management** — View player list; add/remove players; toggle whitelist on/off
6. **Ban management** — View ban list; add/remove bans with reasons
7. **Backup management** — Create backup with optional label; list with metadata; restore with double confirmation
8. **Crash history** — Timeline of detected issues; click for detail with raw log excerpt
9. **Audit log** — Chronological list of all admin actions; filterable; exportable
10. **Settings** — Configure paths, service name, session timeout, feature flags, user management, 2FA setup

## 3. Data Structures and Interfaces Overview

See `class_diagram.plantuml` for the full class diagram.

**Key interfaces:**
- `IAuthService` — Login, TOTP, session management, lockout
- `IHelperClient` — HMAC-signed communication with helper service
- `IServerService` — Start/stop/restart/status via helper
- `IConsoleService` — Send commands and capture output via tmux
- `IWhitelistService` — Whitelist CRUD (command-based when running, file-based when stopped)
- `IBanService` — Ban CRUD
- `IBackupService` — Create/list/restore/delete backups
- `ICrashService` — Detect and store crash events
- `IAuditService` — Log and query audit entries
- `IStatsService` — System and process statistics

**Helper-side handlers:**
- `ServerControlHandler` — systemctl wrapper
- `ConsoleHandler` — tmux send-keys / capture-pane
- `FileHandler` — Safe whitelist/ban file I/O
- `BackupHandler` — tar create/restore with path guards

**Security utilities:**
- `PathGuard` — Path traversal prevention
- `InputSanitizer` — Console command sanitization
- `HmacAuth` — Request signing and validation
- `CommandExecutor` — Safe subprocess execution (no shell)

## 4. Program Call Flow Overview

See `sequence_diagram.plantuml` for detailed sequence diagrams covering:

1. **Authentication flow** — Login → password verification → required admin TOTP enrollment or TOTP verification → session creation
2. **Server restart flow** — UI confirmation → API validation → HMAC-signed helper request → systemctl → audit log
3. **Live console flow** — WebSocket upgrade → subscribe → periodic capture-pane polling → diff → send new lines; command sending with sanitization
4. **Backup restore flow** — Double confirmation → server-stopped check → safety snapshot → tar validation → restore → audit log

## 5. Database ER Diagram Overview

See `er_diagram.plantuml` for the full ER diagram.

**Tables:**
- `users` — Admin accounts with Argon2 hashes, optional encrypted TOTP secrets, lockout tracking
- `sessions` — Active sessions with IP binding and expiry
- `audit_logs` — Every significant action with user, target, details, success/failure
- `backup_metadata` — Backup records with SHA256 integrity hashes
- `crash_events` — Detected crash/error events with severity and human-readable summaries
- `settings` — Key-value configuration store

## 6. Unclear Aspects & Assumptions

### Uncertain
1. **Hytale console command syntax** — Assumed standard game server commands (whitelist add/remove, ban, save). May need adjustment.
2. **Hytale log format** — Crash patterns based on common game server patterns. Regex may need tuning.
3. **Player count detection** — Best-effort parsing of join/leave log messages. Falls back to "unknown".
4. **Ban file format** — Assumed JSON at `/opt/hytale/Server/bans.json`. May not exist.
5. **Whitelist toggle** — Assumed `whitelist on/off` commands. May require config file edit + restart.

### Assumptions
1. Hytale server accepts stdin commands when run interactively
2. Ubuntu 22.04+ with systemd 249+, Docker Engine 24+, Docker Compose v2
3. `/opt/hytale/start.sh` exists and launches the server
4. Admin sets up reverse proxy for TLS termination
5. Maximum 3 concurrent admin users
6. Backup size manageable (< 10GB per world backup)
